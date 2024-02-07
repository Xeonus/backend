import { formatEther, formatUnits } from 'ethers/lib/utils';
import { Multicaller3 } from '../../web3/multicaller3';
import { PrismaPoolType } from '@prisma/client';
import { BigNumber, formatFixed } from '@ethersproject/bignumber';
import ElementPoolAbi from '../abi/ConvergentCurvePool.json';
import LinearPoolAbi from '../abi/LinearPool.json';
import LiquidityBootstrappingPoolAbi from '../abi/LiquidityBootstrappingPool.json';
import ComposableStablePoolAbi from '../abi/ComposableStablePool.json';
import GyroEV2Abi from '../abi/GyroEV2.json';
import VaultAbi from '../abi/Vault.json';
import aTokenRateProvider from '../abi/StaticATokenRateProvider.json';
import WeightedPoolAbi from '../abi/WeightedPool.json';
import StablePoolAbi from '../abi/StablePool.json';
import MetaStablePoolAbi from '../abi/MetaStablePool.json';
import StablePhantomPoolAbi from '../abi/StablePhantomPool.json';
import BalancerQueries from '../abi/BalancerQueries.json';
import { filter, result } from 'lodash';
import { MathSol, WAD, ZERO_ADDRESS } from '@balancer/sdk';
import { parseUnits } from 'viem';

interface PoolInput {
    id: string;
    address: string;
    tokens: {
        address: string;
        token: {
            decimals: number;
        };
        dynamicData: {
            balance: string;
            balanceUSD: number;
        } | null;
    }[];
    dynamicData: {
        totalLiquidity: number;
    } | null;
}

interface PoolTokenPairsOutput {
    [poolId: string]: {
        tokenPairs: {
            id: string;
            normalizedLiquidity: string;
            spotPrice: string;
        }[];
    };
}

interface TokenPair {
    poolId: string;
    poolTvl: number;
    valid: boolean;
    tokenA: Token;
    tokenB: Token;
    normalizedLiqudity: bigint;
    spotPrice: bigint;
    aToBPrice: bigint;
    aToBAmountIn: bigint;
    aToBAmountOut: bigint;
    bToAPrice: bigint;
    bToAAmountOut: bigint;
    effectivePrice: bigint;
    effectivePriceAmountIn: bigint;
}

interface Token {
    address: string;
    decimals: number;
    balance: string;
    balanceUsd: number;
}

interface OnchainData {
    effectivePriceAmountOut: BigNumber;
    aToBAmountOut: BigNumber;
    bToAAmountOut: BigNumber;
}

export async function fetchNormalizedLiquidity(pools: PoolInput[], balancerQueriesAddress: string, batchSize = 1024) {
    if (pools.length === 0) {
        return {};
    }

    const poolsOutput: PoolTokenPairsOutput = {};

    const multicaller = new Multicaller3(BalancerQueries, batchSize);

    // only inlcude pools with TVL >=$1000
    // for each pool, get pairs
    // for each pair per pool, create multicall to do a swap with $200 (min liq is $1k, so there should be at least $200 for each token) for effectivePrice calc and a swap with 1% TVL
    //     then create multicall to do the second swap for each pair using the result of the first 1% swap as input, to calculate the spot price
    // https://github.com/balancer/b-sdk/pull/204/files#diff-52e6d86a27aec03f59dd3daee140b625fd99bd9199936bbccc50ee550d0b0806

    const tokenPairs = generateTokenPairs(pools);

    tokenPairs.forEach((tokenPair) => {
        if (tokenPair.valid) {
            // prepare swap amounts in
            // tokenA->tokenB with 1% of tokenA balance
            tokenPair.aToBAmountIn = parseUnits(tokenPair.tokenA.balance, tokenPair.tokenA.decimals) / 100n;
            // tokenA->tokenB with 100USD worth of tokenA
            const oneHundredUsdOfTokenA = (parseFloat(tokenPair.tokenA.balance) / tokenPair.tokenA.balanceUsd) * 100;
            tokenPair.effectivePriceAmountIn = parseUnits(`${oneHundredUsdOfTokenA}`, tokenPair.tokenA.decimals);

            addEffectivePriceCallsToMulticaller(tokenPair, balancerQueriesAddress, multicaller);
            addAToBPriceCallsToMulticaller(tokenPair, balancerQueriesAddress, multicaller);
        }
    });

    const resultOne = (await multicaller.execute()) as {
        [id: string]: OnchainData;
    };

    tokenPairs.forEach((tokenPair) => {
        if (tokenPair.valid) {
            getAmountOutAndEffectivePriceFromResult(tokenPair, resultOne);
        }
    });

    tokenPairs.forEach((tokenPair) => {
        if (tokenPair.valid) {
            addBToAPriceCallsToMulticaller(tokenPair, balancerQueriesAddress, multicaller);
        }
    });

    const resultTwo = (await multicaller.execute()) as {
        [id: string]: OnchainData;
    };

    tokenPairs.forEach((tokenPair) => {
        if (tokenPair.valid) {
            getBToAAmountFromResult(tokenPair, resultTwo);
            calculateSpotPrice(tokenPair);
            calculateNormalizedLiquidity(tokenPair);
        }

        // prepare output
        pools.forEach((pool) => {
            if (pool.id === tokenPair.poolId) {
                if (!poolsOutput[pool.id]) {
                    poolsOutput[pool.id] = {
                        tokenPairs: [],
                    };
                }
                poolsOutput[pool.id].tokenPairs.push({
                    id: `${pool.id}-${tokenPair.tokenA.address}-${tokenPair.tokenB.address}`,
                    normalizedLiquidity: tokenPair.normalizedLiqudity.toString(),
                    spotPrice: tokenPair.spotPrice.toString(),
                });
            }
        });
    });

    return poolsOutput;
}

function generateTokenPairs(filteredPools: PoolInput[]): TokenPair[] {
    const tokenPairs: TokenPair[] = [];

    for (const pool of filteredPools) {
        // search for and delete phantom BPT if present
        let index: number | undefined = undefined;
        pool.tokens.forEach((poolToken, i) => {
            if (poolToken.address === pool.address) {
                index = i;
            }
        });
        if (index) {
            pool.tokens.splice(index, 1);
        }

        // create all pairs for pool
        for (let i = 0; i < pool.tokens.length - 1; i++) {
            for (let j = i + 1; j < pool.tokens.length; j++) {
                tokenPairs.push({
                    poolId: pool.id,
                    poolTvl: pool.dynamicData?.totalLiquidity || 0,
                    // remove pools that have <$1000 TVL or a token without a balance or USD balance
                    valid:
                        (pool.dynamicData?.totalLiquidity || 0) >= 1000 &&
                        pool.tokens.some((token) => token.dynamicData?.balance || '0' !== '0') &&
                        pool.tokens.some((token) => token.dynamicData?.balanceUSD || 0 !== 0),

                    tokenA: {
                        address: pool.tokens[i].address,
                        decimals: pool.tokens[i].token.decimals,
                        balance: pool.tokens[i].dynamicData?.balance || '0',
                        balanceUsd: pool.tokens[i].dynamicData?.balanceUSD || 0,
                    },
                    tokenB: {
                        address: pool.tokens[j].address,
                        decimals: pool.tokens[j].token.decimals,
                        balance: pool.tokens[j].dynamicData?.balance || '0',
                        balanceUsd: pool.tokens[j].dynamicData?.balanceUSD || 0,
                    },
                    normalizedLiqudity: 0n,
                    spotPrice: 0n,
                    aToBPrice: 0n,
                    aToBAmountIn: 0n,
                    aToBAmountOut: 0n,
                    bToAPrice: 0n,
                    bToAAmountOut: 0n,
                    effectivePrice: 0n,
                    effectivePriceAmountIn: 0n,
                });
            }
        }
    }
    return tokenPairs;
}

// call querySwap from tokenA->tokenB with 100USD worth of tokenA
function addEffectivePriceCallsToMulticaller(
    tokenPair: TokenPair,
    balancerQueriesAddress: string,
    multicaller: Multicaller3,
) {
    multicaller.call(
        `${tokenPair.poolId}-${tokenPair.tokenA.address}-${tokenPair.tokenB.address}.effectivePriceAmountOut`,
        balancerQueriesAddress,
        'querySwap',
        [
            [
                tokenPair.poolId,
                0,
                tokenPair.tokenA.address,
                tokenPair.tokenB.address,
                `${tokenPair.effectivePriceAmountIn}`,
                ZERO_ADDRESS,
            ],
            [ZERO_ADDRESS, false, ZERO_ADDRESS, false],
        ],
    );
}

// call querySwap from tokenA->tokenB with 1% of tokenA balance
function addAToBPriceCallsToMulticaller(
    tokenPair: TokenPair,
    balancerQueriesAddress: string,
    multicaller: Multicaller3,
) {
    multicaller.call(
        `${tokenPair.poolId}-${tokenPair.tokenA.address}-${tokenPair.tokenB.address}.aToBAmountOut`,
        balancerQueriesAddress,
        'querySwap',
        [
            [
                tokenPair.poolId,
                0,
                tokenPair.tokenA.address,
                tokenPair.tokenB.address,
                `${tokenPair.aToBAmountIn}`,
                ZERO_ADDRESS,
            ],
            [ZERO_ADDRESS, false, ZERO_ADDRESS, false],
        ],
    );
}

// call querySwap from tokenA->tokenB with AtoB amount out
function addBToAPriceCallsToMulticaller(
    tokenPair: TokenPair,
    balancerQueriesAddress: string,
    multicaller: Multicaller3,
) {
    multicaller.call(
        `${tokenPair.poolId}-${tokenPair.tokenA.address}-${tokenPair.tokenB.address}.bToAAmountOut`,
        balancerQueriesAddress,
        'querySwap',
        [
            [
                tokenPair.poolId,
                0,
                tokenPair.tokenB.address,
                tokenPair.tokenA.address,
                `${tokenPair.aToBAmountOut}`,
                ZERO_ADDRESS,
            ],
            [ZERO_ADDRESS, false, ZERO_ADDRESS, false],
        ],
    );
}

function getAmountOutAndEffectivePriceFromResult(tokenPair: TokenPair, onchainResults: { [id: string]: OnchainData }) {
    const result = onchainResults[`${tokenPair.poolId}-${tokenPair.tokenA.address}-${tokenPair.tokenB.address}`];

    if (result) {
        tokenPair.aToBAmountOut = BigInt(result.aToBAmountOut.toString());
        tokenPair.effectivePrice = MathSol.divDownFixed(
            tokenPair.effectivePriceAmountIn,
            BigInt(result.effectivePriceAmountOut.toString()),
        );
    }
}

function getBToAAmountFromResult(tokenPair: TokenPair, onchainResults: { [id: string]: OnchainData }) {
    const result = onchainResults[`${tokenPair.poolId}-${tokenPair.tokenA.address}-${tokenPair.tokenB.address}`];

    if (result) {
        tokenPair.bToAAmountOut = BigInt(result.bToAAmountOut.toString());
    }
}
function calculateSpotPrice(tokenPair: TokenPair) {
    const priceAtoB = MathSol.divDownFixed(tokenPair.aToBAmountIn, tokenPair.aToBAmountOut);
    const priceBtoA = MathSol.divDownFixed(tokenPair.aToBAmountOut, tokenPair.bToAAmountOut);
    tokenPair.spotPrice = MathSol.powDownFixed(MathSol.divDownFixed(priceAtoB, priceBtoA), WAD / 2n);
}

function calculateNormalizedLiquidity(tokenPair: TokenPair) {
    const priceRatio = MathSol.divDownFixed(tokenPair.spotPrice, tokenPair.effectivePrice);
    const priceImpact = WAD - priceRatio;
    tokenPair.normalizedLiqudity = MathSol.divDownFixed(WAD, priceImpact);
}