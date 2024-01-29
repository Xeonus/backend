import { Address, Hex, parseEther, parseUnits } from 'viem';
import { GqlPoolType } from '../../../../../../schema';
import { Token } from '../../entities/token';
import { BigintIsh, TokenAmount } from '../../entities/tokenAmount';
import { BasePool, SwapKind } from '../../types';
import { PrismaPoolWithDynamic } from '../../../../../../prisma/prisma-types';
import { Chain } from '@prisma/client';
import { MathSol, WAD } from '../../utils/math';
import { MathGyro, SWAP_LIMIT_FACTOR } from '../../utils/gyroHelpers/math';
import { DerivedGyroEParams, GyroEParams, Vector2 } from './types';
import { balancesFromTokenInOut, virtualOffset0, virtualOffset1 } from './gyroEMathHelpers';
import { calculateInvariantWithError, calcOutGivenIn, calcInGivenOut } from './gyroEMath';

export class GyroEPoolToken extends TokenAmount {
    public readonly rate: bigint;
    public readonly index: number;

    public constructor(token: Token, amount: BigintIsh, rate: BigintIsh, index: number) {
        super(token, amount);
        this.rate = BigInt(rate);
        this.scale18 = (this.amount * this.scalar * this.rate) / WAD;
        this.index = index;
    }

    public increase(amount: bigint): TokenAmount {
        this.amount = this.amount + amount;
        this.scale18 = (this.amount * this.scalar * this.rate) / WAD;
        return this;
    }

    public decrease(amount: bigint): TokenAmount {
        this.amount = this.amount - amount;
        this.scale18 = (this.amount * this.scalar * this.rate) / WAD;
        return this;
    }
}

export class GyroEPool implements BasePool {
    public readonly chain: Chain;
    public readonly id: Hex;
    public readonly address: string;
    public readonly poolType: GqlPoolType = 'GYROE';
    public readonly poolTypeVersion: number;
    public readonly swapFee: bigint;
    public readonly tokens: GyroEPoolToken[];
    public readonly gyroEParams: GyroEParams;
    public readonly derivedGyroEParams: DerivedGyroEParams;

    private readonly tokenMap: Map<string, GyroEPoolToken>;

    static fromPrismaPool(pool: PrismaPoolWithDynamic): GyroEPool {
        const poolTokens: GyroEPoolToken[] = [];

        if (!pool.dynamicData || !pool.gyroData) {
            throw new Error('No dynamic data for pool');
        }

        for (const poolToken of pool.tokens) {
            if (!poolToken.dynamicData) {
                throw new Error('Gyro pool as no dynamic pool token data');
            }

            const token = new Token(
                poolToken.address as Address,
                poolToken.token.decimals,
                poolToken.token.symbol,
                poolToken.token.name,
            );
            const tokenAmount = TokenAmount.fromHumanAmount(token, poolToken.dynamicData.balance);
            const tokenRate = poolToken.dynamicData.priceRate;

            poolTokens.push(new GyroEPoolToken(token, tokenAmount.amount, tokenRate, poolToken.index));
        }

        const gyroEParams: GyroEParams = {
            alpha: parseEther(pool.gyroData.alpha),
            beta: parseEther(pool.gyroData.beta),
            c: parseEther(pool.gyroData.c!),
            s: parseEther(pool.gyroData.s!),
            lambda: parseEther(pool.gyroData.lambda!),
        };

        const derivedGyroEParams: DerivedGyroEParams = {
            tauAlpha: {
                x: parseUnits(pool.gyroData.tauAlphaX!, 38),
                y: parseUnits(pool.gyroData.tauAlphaY!, 38),
            },
            tauBeta: {
                x: parseUnits(pool.gyroData.tauBetaX!, 38),
                y: parseUnits(pool.gyroData.tauBetaY!, 38),
            },
            u: parseUnits(pool.gyroData.u!, 38),
            v: parseUnits(pool.gyroData.v!, 38),
            w: parseUnits(pool.gyroData.w!, 38),
            z: parseUnits(pool.gyroData.z!, 38),
            dSq: parseUnits(pool.gyroData.dSq!, 38),
        };

        return new GyroEPool(
            pool.id as Hex,
            pool.address,
            pool.chain,
            pool.version,
            parseEther(pool.dynamicData.swapFee),
            poolTokens,
            gyroEParams,
            derivedGyroEParams,
        );
    }

    constructor(
        id: Hex,
        address: string,
        chain: Chain,
        poolTypeVersion: number,
        swapFee: bigint,
        tokens: GyroEPoolToken[],
        gyroEParams: GyroEParams,
        derivedGyroEParams: DerivedGyroEParams,
    ) {
        this.id = id;
        this.address = address;
        this.chain = chain;
        this.poolTypeVersion = poolTypeVersion;
        this.swapFee = swapFee;
        this.tokens = tokens;
        this.tokenMap = new Map(this.tokens.map((token) => [token.token.address, token]));
        this.gyroEParams = gyroEParams;
        this.derivedGyroEParams = derivedGyroEParams;
    }

    public getNormalizedLiquidity(tokenIn: Token, tokenOut: Token): bigint {
        const tIn = this.tokenMap.get(tokenIn.wrapped);
        const tOut = this.tokenMap.get(tokenOut.wrapped);

        if (!tIn || !tOut) throw new Error('Pool does not contain the tokens provided');
        // TODO: Fix gyro normalized liquidity calc
        return tOut.amount;
    }

    public swapGivenIn(
        tokenIn: Token,
        tokenOut: Token,
        swapAmount: TokenAmount,
        mutateBalances?: boolean,
    ): TokenAmount {
        const { tIn, tOut } = this.getRequiredTokenPair(tokenIn, tokenOut);
        const orderedNormalizedBalances = balancesFromTokenInOut(tIn.scale18, tOut.scale18, tIn.index === 0);
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.gyroEParams,
            this.derivedGyroEParams,
        );

        const invariant: Vector2 = {
            x: currentInvariant + invErr * 2n,
            y: currentInvariant,
        };
        const inAmount = GyroEPoolToken.fromRawAmount(tokenIn, swapAmount.amount);
        const inAmountLessFee = this.subtractSwapFeeAmount(inAmount);
        const inAmountWithRate = inAmountLessFee.mulDownFixed(tIn.rate);
        const outAmountScale18 = calcOutGivenIn(
            orderedNormalizedBalances,
            inAmountWithRate.scale18,
            tIn.index === 0,
            this.gyroEParams,
            this.derivedGyroEParams,
            invariant,
        );

        const outAmountWithRate = TokenAmount.fromScale18Amount(tokenOut, outAmountScale18);

        const outAmount = outAmountWithRate.divDownFixed(tOut.rate);

        if (mutateBalances) {
            tIn.increase(swapAmount.amount);
            tOut.decrease(outAmount.amount);
        }

        return outAmount;
    }

    public swapGivenOut(
        tokenIn: Token,
        tokenOut: Token,
        swapAmount: TokenAmount,
        mutateBalances?: boolean,
    ): TokenAmount {
        const { tIn, tOut } = this.getRequiredTokenPair(tokenIn, tokenOut);
        const orderedNormalizedBalances = balancesFromTokenInOut(tIn.scale18, tOut.scale18, tIn.index === 0);
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.gyroEParams,
            this.derivedGyroEParams,
        );
        const invariant: Vector2 = {
            x: currentInvariant + invErr * 2n,
            y: currentInvariant,
        };

        const inAmountLessFee = calcInGivenOut(
            orderedNormalizedBalances,
            swapAmount.scale18,
            tIn.index === 0,
            this.gyroEParams,
            this.derivedGyroEParams,
            invariant,
        );

        const inAmount = this.addSwapFeeAmount(GyroEPoolToken.fromScale18Amount(tokenIn, inAmountLessFee));

        const inAmountWithRate = inAmount.divUpFixed(tIn.rate);

        if (mutateBalances) {
            tIn.decrease(inAmountWithRate.amount);
            tOut.increase(swapAmount.amount);
        }

        return inAmountWithRate;
    }

    public getLimitAmountSwap(tokenIn: Token, tokenOut: Token, swapKind: SwapKind): bigint {
        const { tIn, tOut } = this.getRequiredTokenPair(tokenIn, tokenOut);
        if (swapKind === SwapKind.GivenIn) {
            const orderedNormalizedBalances = balancesFromTokenInOut(tIn.scale18, tOut.scale18, tIn.index === 0);
            const [currentInvariant, invErr] = calculateInvariantWithError(
                orderedNormalizedBalances,
                this.gyroEParams,
                this.derivedGyroEParams,
            );
            const invariant: Vector2 = {
                x: currentInvariant + invErr * 2n,
                y: currentInvariant,
            };
            const virtualOffsetFunc = tIn.index === 0 ? virtualOffset0 : virtualOffset1;
            const maxAmountInAssetInPool =
                virtualOffsetFunc(this.gyroEParams, this.derivedGyroEParams, invariant) -
                virtualOffsetFunc(this.gyroEParams, this.derivedGyroEParams, invariant, true);
            const limitAmountIn = MathGyro.divDown(maxAmountInAssetInPool - tIn.scale18, tIn.rate);
            const limitAmountInPlusSwapFee = MathGyro.divDown(limitAmountIn, WAD - this.swapFee);
            return MathGyro.mulDown(limitAmountInPlusSwapFee, SWAP_LIMIT_FACTOR);
        }
        return MathGyro.mulDown(tOut.amount, SWAP_LIMIT_FACTOR);
    }

    public subtractSwapFeeAmount(amount: TokenAmount): TokenAmount {
        const feeAmount = amount.mulUpFixed(this.swapFee);
        return amount.sub(feeAmount);
    }

    public addSwapFeeAmount(amount: TokenAmount): TokenAmount {
        return amount.divUpFixed(MathSol.complementFixed(this.swapFee));
    }

    getRequiredTokenPair(
        tokenIn: Token,
        tokenOut: Token,
    ): {
        tIn: GyroEPoolToken;
        tOut: GyroEPoolToken;
    } {
        const tIn = this.tokenMap.get(tokenIn.wrapped);
        const tOut = this.tokenMap.get(tokenOut.wrapped);

        if (!tIn || !tOut) {
            throw new Error('Pool does not contain the tokens provided');
        }

        return { tIn, tOut };
    }
}
