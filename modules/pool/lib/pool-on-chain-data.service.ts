import { Provider } from '@ethersproject/providers';
import VaultAbi from '../abi/Vault.json';
import aTokenRateProvider from '../abi/StaticATokenRateProvider.json';
import WeightedPoolAbi from '../abi/WeightedPool.json';
import StablePoolAbi from '../abi/StablePool.json';
import MetaStablePool from '../abi/MetaStablePool.json';
import ElementPoolAbi from '../abi/ConvergentCurvePool.json';
import LinearPoolAbi from '../abi/LinearPool.json';
import StablePhantomPoolAbi from '../abi/StablePhantomPool.json';
import ComposableStablePoolAbi from '../abi/ComposableStablePool.json';
import LiquidityBootstrappingPoolAbi from '../abi/LiquidityBootstrappingPool.json';
import { Multicaller } from '../../web3/multicaller';
import { BigNumber, Contract } from 'ethers';
import { formatFixed } from '@ethersproject/bignumber';
import { PrismaPoolType } from '@prisma/client';
import { isSameAddress } from '@balancer-labs/sdk';
import { prisma } from '../../../prisma/prisma-client';
import { isComposableStablePool, isStablePool, isWeightedPoolV2 } from './pool-utils';
import { TokenService } from '../../token/token.service';
import { WeiPerEther } from '@ethersproject/constants';
import BalancerPoolDataQueryAbi from '../abi/BalancerPoolDataQueries.json';
import { networkConfig } from '../../config/network-config';
import { jsonRpcProvider } from '../../web3/contract';

enum PoolQueriesTotalSupplyType {
    TOTAL_SUPPLY = 0,
    VIRTUAL_SUPPLY,
    ACTUAL_SUPPLY,
}

enum PoolQuerySwapFeeType {
    SWAP_FEE_PERCENTAGE = 0,
    PERCENT_FEE,
}

interface PoolDataQueryConfig {
    loadTokenBalanceUpdatesAfterBlock: boolean;
    loadTotalSupply: boolean;
    loadSwapFees: boolean;
    loadLinearWrappedTokenRates: boolean;
    loadNormalizedWeights: boolean;
    loadScalingFactors: boolean;
    loadAmps: boolean;
    loadRates: boolean;
    blockNumber: number;
    totalSupplyTypes: PoolQueriesTotalSupplyType[];
    swapFeeTypes: PoolQuerySwapFeeType[];
    linearPoolIdxs: number[];
    weightedPoolIdxs: number[];
    scalingFactorPoolIdxs: number[];
    ampPoolIdxs: number[];
    ratePoolIdxs: number[];
}

const defaultPoolDataQueryConfig: PoolDataQueryConfig = {
    loadTokenBalanceUpdatesAfterBlock: false,
    loadTotalSupply: false,
    loadSwapFees: false,
    loadLinearWrappedTokenRates: false,
    loadNormalizedWeights: false,
    loadScalingFactors: false,
    loadAmps: false,
    loadRates: false,
    blockNumber: 0,
    totalSupplyTypes: [],
    swapFeeTypes: [],
    linearPoolIdxs: [],
    weightedPoolIdxs: [],
    scalingFactorPoolIdxs: [],
    ampPoolIdxs: [],
    ratePoolIdxs: [],
};
interface MulticallExecuteResult {
    targets?: string[];
    poolTokens: {
        tokens: string[];
        balances: string[];
    };
    swapEnabled?: boolean;
    metaPriceRateCache?: [BigNumber, BigNumber, BigNumber][];
    stablePhantomPools?: Record<
        string,
        {
            id: string;
            tokenRates: BigNumber[];
            poolTokens: {
                tokens: string[];
                balances: string[];
            };
        }
    >;
}

const SUPPORTED_POOL_TYPES: PrismaPoolType[] = [
    'WEIGHTED',
    'STABLE',
    'META_STABLE',
    'PHANTOM_STABLE',
    'LINEAR',
    'LIQUIDITY_BOOTSTRAPPING',
    'ELEMENT',
];

export interface poolIdWithType {
    id: string;
    type: PrismaPoolType;
}

export class PoolOnChainDataService {
    constructor(private readonly tokenService: TokenService) {}

    public async updateOnChainData(poolIds: string[], provider: Provider, blockNumber: number): Promise<void> {
        if (poolIds.length === 0) return;

        const pools = await prisma.prismaPool.findMany({
            where: { id: { in: poolIds } },
            include: {
                tokens: { orderBy: { index: 'asc' }, include: { dynamicData: true, token: true } },
                stableDynamicData: true,
                dynamicData: true,
                linearDynamicData: true,
                linearData: true,
            },
        });

        const retrievedPoolIds = pools.map((pool) => pool.id);

        const weightedPoolIndexes: number[] = [];
        const linearPoolIdexes: number[] = [];
        const stablePoolIdexes: number[] = [];
        for (const pool of pools) {
            if (pool.type === 'WEIGHTED' || pool.type === 'LIQUIDITY_BOOTSTRAPPING' || pool.type === 'INVESTMENT') {
                weightedPoolIndexes.push(retrievedPoolIds.findIndex((orderedPoolId) => orderedPoolId === pool.id));
            }
            if (pool.type === 'LINEAR') {
                linearPoolIdexes.push(retrievedPoolIds.findIndex((orderedPoolId) => orderedPoolId === pool.id));
            }
            if (isStablePool(pool.type)) {
                stablePoolIdexes.push(retrievedPoolIds.findIndex((orderedPoolId) => orderedPoolId === pool.id));
            }
        }

        const poolData = await this.getPoolData({
            poolIds: retrievedPoolIds,
            config: {
                loadTokenBalanceUpdatesAfterBlock: true,
                blockNumber: 0, // always get balances from all pools
                loadAmps: stablePoolIdexes.length > 0,
                ampPoolIdxs: stablePoolIdexes,
                loadSwapFees: true,
                swapFeeTypes: pools.map((pool) => {
                    if (
                        pool.type === 'WEIGHTED' ||
                        pool.type === 'LIQUIDITY_BOOTSTRAPPING' ||
                        pool.type === 'INVESTMENT' ||
                        pool.type === 'LINEAR' ||
                        isStablePool(pool.type)
                        // MetaStable & StablePhantom is the same as Stable for swapfee purposes
                    ) {
                        return PoolQuerySwapFeeType.SWAP_FEE_PERCENTAGE;
                    } else {
                        return PoolQuerySwapFeeType.PERCENT_FEE;
                    }
                }),
                loadTotalSupply: true,
                totalSupplyTypes: pools.map((pool) => {
                    if (isComposableStablePool(pool) || isWeightedPoolV2(pool) || pool.type === 'PHANTOM_STABLE') {
                        return PoolQueriesTotalSupplyType.ACTUAL_SUPPLY;
                    } else if (pool.type === 'LINEAR') {
                        return PoolQueriesTotalSupplyType.VIRTUAL_SUPPLY;
                    } else {
                        return PoolQueriesTotalSupplyType.TOTAL_SUPPLY;
                    }
                }),
                loadNormalizedWeights: weightedPoolIndexes.length > 0,
                weightedPoolIdxs: weightedPoolIndexes,
                loadLinearWrappedTokenRates: linearPoolIdexes.length > 0,
                linearPoolIdxs: linearPoolIdexes,
                loadRates: linearPoolIdexes.length > 0,
                ratePoolIdxs: linearPoolIdexes,
            },
        });

        const poolDataPerPool = retrievedPoolIds.map((poolId, i) => ({
            id: retrievedPoolIds[i],
            balances: poolData.balances[i],
            totalSupply: poolData.totalSupplies[i],
            weights: weightedPoolIndexes.includes(i) ? poolData.weights[weightedPoolIndexes.indexOf(i)] : undefined,
            amp: stablePoolIdexes.includes(i) ? poolData.amps[stablePoolIdexes.indexOf(i)] : undefined,
            wrappedTokenRate: linearPoolIdexes.includes(i)
                ? poolData.linearWrappedTokenRates[linearPoolIdexes.indexOf(i)]
                : undefined,
            swapFee: poolData.swapFees[i],
            rate: linearPoolIdexes.includes(i) ? poolData.rates[linearPoolIdexes.indexOf(i)] : undefined,
        }));

        const tokenPrices = await this.tokenService.getTokenPrices();

        const abis: any = Object.values(
            // Remove duplicate entries using their names
            Object.fromEntries(
                [
                    ...VaultAbi,
                    ...aTokenRateProvider,
                    ...WeightedPoolAbi,
                    ...StablePoolAbi,
                    ...ElementPoolAbi,
                    ...LinearPoolAbi,
                    ...LiquidityBootstrappingPoolAbi,
                    ...StablePhantomPoolAbi,
                    ...MetaStablePool,
                    ...ComposableStablePoolAbi,
                    //...WeightedPoolV2Abi,
                ].map((row) => [row.name, row]),
            ),
        );

        const multiPool = new Multicaller(networkConfig.multicall, provider, abis);

        pools.forEach((pool) => {
            if (!SUPPORTED_POOL_TYPES.includes(pool.type || '')) {
                console.error(`Unknown pool type: ${pool.type} ${pool.id}`);
                return;
            }
            multiPool.call(`${pool.id}.poolTokens`, networkConfig.balancer.vault, 'getPoolTokens', [pool.id]);

            if (pool.type === 'LINEAR') {
                multiPool.call(`${pool.id}.targets`, pool.address, 'getTargets');
            }

            if (pool.type === 'LIQUIDITY_BOOTSTRAPPING' || pool.type === 'INVESTMENT') {
                multiPool.call(`${pool.id}.swapEnabled`, pool.address, 'getSwapEnabled');
            }

            if (pool.type === 'META_STABLE') {
                const tokenAddresses = pool.tokens.map((token) => token.address);

                tokenAddresses.forEach((token, i) => {
                    multiPool.call(`${pool.id}.metaPriceRateCache[${i}]`, pool.address, 'getPriceRateCache', [token]);
                });
            }

            if (pool.type === 'PHANTOM_STABLE') {
                //we retrieve token rates for phantom stable and composable stable pools
                const tokenAddresses = pool.tokens.map((token) => token.address);

                tokenAddresses.forEach((token, i) => {
                    multiPool.call(`${pool.id}.tokenRates[${i}]`, pool.address, 'getTokenRate', [token]);
                });
            }
        });

        let poolsOnChainData = {} as Record<string, MulticallExecuteResult>;

        try {
            poolsOnChainData = (await multiPool.execute()) as Record<string, MulticallExecuteResult>;
        } catch (err: any) {
            console.error(err);
            throw `Issue with multicall execution. ${err}`;
        }

        const poolsOnChainDataArray = Object.entries(poolsOnChainData);

        for (let index = 0; index < poolsOnChainDataArray.length; index++) {
            const [poolId, onchainData] = poolsOnChainDataArray[index];
            const pool = pools.find((pool) => pool.id === poolId)!;
            const poolDataQueryResult = poolDataPerPool.find((poolData) => poolData.id === pool.id);
            if (!poolDataQueryResult) {
                throw Error(`Did not receive poolDataQuery result for pool id ${poolId}`);
            }
            const { poolTokens } = onchainData;

            try {
                if (isStablePool(pool.type)) {
                    if (!poolDataQueryResult.amp) {
                        console.log('onchain data', onchainData);
                        console.error(`Stable Pool Missing Amp: ${poolId}`);
                        continue;
                    }

                    // Need to scale amp by precision to match expected Subgraph scale
                    // amp is stored with 3 decimals of precision
                    const amp = formatFixed(poolDataQueryResult.amp, 3);

                    //only update if amp has changed
                    if (!pool.stableDynamicData || pool.stableDynamicData.amp !== amp) {
                        await prisma.prismaPoolStableDynamicData.upsert({
                            where: { id: pool.id },
                            create: { id: pool.id, poolId: pool.id, amp, blockNumber },
                            update: { amp, blockNumber },
                        });
                    }
                }

                if (pool.type === 'LINEAR') {
                    if (!onchainData.targets) {
                        console.error(`Linear Pool Missing Targets: ${poolId}`);
                        continue;
                    } else {
                        const lowerTarget = formatFixed(onchainData.targets[0], 18);
                        const upperTarget = formatFixed(onchainData.targets[1], 18);

                        if (
                            !pool.linearDynamicData ||
                            pool.linearDynamicData.lowerTarget !== lowerTarget ||
                            pool.linearDynamicData.upperTarget !== upperTarget
                        ) {
                            await prisma.prismaPoolLinearDynamicData.upsert({
                                where: { id: pool.id },
                                create: {
                                    id: pool.id,
                                    poolId: pool.id,
                                    upperTarget,
                                    lowerTarget,
                                    blockNumber,
                                },
                                update: { upperTarget, lowerTarget, blockNumber },
                            });
                        }
                    }
                }

                const swapFee = formatFixed(poolDataQueryResult.swapFee, 18);
                const totalShares = formatFixed(poolDataQueryResult.totalSupply, 18);
                const swapEnabled =
                    typeof onchainData.swapEnabled !== 'undefined'
                        ? onchainData.swapEnabled
                        : pool.dynamicData?.swapEnabled;

                if (
                    pool.dynamicData &&
                    (pool.dynamicData.swapFee !== swapFee ||
                        pool.dynamicData.totalShares !== totalShares ||
                        pool.dynamicData.swapEnabled !== swapEnabled)
                ) {
                    await prisma.prismaPoolDynamicData.update({
                        where: { id: pool.id },
                        data: {
                            swapFee,
                            totalShares,
                            totalSharesNum: parseFloat(totalShares),
                            swapEnabled: typeof swapEnabled !== 'undefined' ? swapEnabled : true,
                            blockNumber,
                        },
                    });
                }

                for (let i = 0; i < poolTokens.tokens.length; i++) {
                    const tokenAddress = poolTokens.tokens[i];
                    const poolToken = pool.tokens.find((token) => isSameAddress(token.address, tokenAddress));

                    if (!poolToken) {
                        throw `Pool Missing Expected Token: ${poolId} ${tokenAddress}`;
                    }

                    const balance = formatFixed(poolTokens.balances[i], poolToken.token.decimals);
                    const weight = poolDataQueryResult.weights ? formatFixed(poolDataQueryResult.weights[i], 18) : null;

                    let priceRate = '1.0';

                    // set the rate of the phantom bpt if present
                    if (poolDataQueryResult.rate && isSameAddress(poolToken.address, pool.address)) {
                        priceRate = formatFixed(poolDataQueryResult.rate, 18);
                    }
                    // set the rate of the wrapped token if present
                    if (poolDataQueryResult.wrappedTokenRate && pool.linearData?.wrappedIndex === i) {
                        priceRate = formatFixed(poolDataQueryResult.wrappedTokenRate, 18);
                    }

                    if (onchainData.metaPriceRateCache && onchainData.metaPriceRateCache[i][0].gt('0')) {
                        priceRate = formatFixed(onchainData.metaPriceRateCache[i][0], 18);
                    }

                    if (
                        !poolToken.dynamicData ||
                        poolToken.dynamicData.balance !== balance ||
                        poolToken.dynamicData.priceRate !== priceRate ||
                        poolToken.dynamicData.weight !== weight
                    ) {
                        await prisma.prismaPoolTokenDynamicData.upsert({
                            where: { id: poolToken.id },
                            create: {
                                id: poolToken.id,
                                poolTokenId: poolToken.id,
                                blockNumber,
                                priceRate,
                                weight,
                                balance,
                                balanceUSD:
                                    poolToken.address === pool.address
                                        ? 0
                                        : this.tokenService.getPriceForToken(tokenPrices, poolToken.address) *
                                          parseFloat(balance),
                            },
                            update: {
                                blockNumber,
                                priceRate,
                                weight,
                                balance,
                                balanceUSD:
                                    poolToken.address === pool.address
                                        ? 0
                                        : this.tokenService.getPriceForToken(tokenPrices, poolToken.address) *
                                          parseFloat(balance),
                            },
                        });
                    }
                }
            } catch (e) {
                console.log('error syncing on chain data', e);
            }
        }
    }
    public async getPoolData({
        poolIds,
        config,
    }: {
        poolIds: string[];
        config: Partial<PoolDataQueryConfig>;
    }): Promise<{
        balances: BigNumber[][];
        totalSupplies: BigNumber[];
        swapFees: BigNumber[];
        linearWrappedTokenRates: BigNumber[];
        weights: BigNumber[][];
        scalingFactors: BigNumber[][];
        amps: BigNumber[];
        rates: BigNumber[];
        ignoreIdxs: BigNumber[];
    }> {
        const contract = new Contract(
            networkConfig.balancer.poolDataQueryContract,
            BalancerPoolDataQueryAbi,
            jsonRpcProvider,
        );

        const response = await contract.getPoolData(poolIds, {
            ...defaultPoolDataQueryConfig,
            ...config,
        });

        return {
            balances: response[0],
            totalSupplies: response[1],
            swapFees: response[2],
            linearWrappedTokenRates: response[3],
            weights: response[4],
            scalingFactors: response[5],
            amps: response[6],
            rates: response[7],
            ignoreIdxs: response[8],
        };
    }
}
