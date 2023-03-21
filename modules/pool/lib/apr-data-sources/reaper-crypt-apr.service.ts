import { isSameAddress } from '@balancer-labs/sdk';
import * as Sentry from '@sentry/node';
import { prisma } from '../../../../prisma/prisma-client';
import { PrismaPoolWithExpandedNesting } from '../../../../prisma/prisma-types';
import { TokenService } from '../../../token/token.service';
import { getContractAt } from '../../../web3/contract';
import { PoolAprService } from '../../pool-types';
import ReaperCryptAbi from './abi/ReaperCrypt.json';
import ReaperCryptStrategyAbi from './abi/ReaperCryptStrategy.json';

export class ReaperCryptAprService implements PoolAprService {
    private readonly APR_PERCENT_DIVISOR = 10_000;

    private readonly SFTMX_ADDRESS = '0xd7028092c830b5c8fce061af2e593413ebbc1fc1';
    private readonly SFTMX_APR = 0.046;

    constructor(
        private readonly linearPoolFactories: string[],
        private readonly averageAPRAcrossLastNHarvests: number,
        private readonly tokenService: TokenService,
    ) {}

    public getAprServiceName(): string {
        return 'ReaperCryptAprService';
    }

    public async updateAprForPools(pools: PrismaPoolWithExpandedNesting[]): Promise<void> {
        const tokenPrices = await this.tokenService.getTokenPrices();

        for (const pool of pools) {
            if (!this.linearPoolFactories.includes(pool.factory || '') || !pool.linearData || !pool.dynamicData) {
                continue;
            }

            const itemId = `${pool.id}-reaper-crypt`;

            const linearData = pool.linearData;
            const wrappedToken = pool.tokens[linearData.wrappedIndex];
            const mainToken = pool.tokens[linearData.mainIndex];

            const cryptContract = getContractAt(wrappedToken.address, ReaperCryptAbi);
            const cryptStrategyAddress = await cryptContract.strategy();
            const strategyContract = getContractAt(cryptStrategyAddress, ReaperCryptStrategyAbi);
            let avgAprAcrossXHarvests = 0;
            try {
                avgAprAcrossXHarvests =
                    (await strategyContract.averageAPRAcrossLastNHarvests(this.averageAPRAcrossLastNHarvests)) /
                    this.APR_PERCENT_DIVISOR;
            } catch (e) {
                Sentry.captureException(e, {
                    tags: {
                        poolId: pool.id,
                        poolName: pool.name,
                        strategyContract: cryptStrategyAddress,
                    },
                });
                continue;
            }

            const tokenPrice = this.tokenService.getPriceForToken(tokenPrices, mainToken.address);
            const wrappedTokens = parseFloat(wrappedToken.dynamicData?.balance || '0');
            const priceRate = parseFloat(wrappedToken.dynamicData?.priceRate || '1.0');
            const poolWrappedLiquidity = wrappedTokens * priceRate * tokenPrice;
            const totalLiquidity = pool.dynamicData.totalLiquidity;
            let apr = totalLiquidity > 0 ? avgAprAcrossXHarvests * (poolWrappedLiquidity / totalLiquidity) : 0;

            await prisma.prismaPoolAprItem.upsert({
                where: { id: itemId },
                create: {
                    id: itemId,
                    poolId: pool.id,
                    title: `${wrappedToken.token.symbol} APR`,
                    apr: apr,
                    group: 'REAPER',
                    type: 'LINEAR_BOOSTED',
                },
                update: { title: `${wrappedToken.token.symbol} APR`, apr: apr },
            });
        }
    }
}
