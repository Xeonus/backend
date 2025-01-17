import {
    PrismaNestedPoolWithNoNesting,
    PrismaNestedPoolWithSingleLayerNesting,
    prismaPoolMinimal,
    PrismaPoolMinimal,
    PrismaPoolTokenWithDynamicData,
    PrismaPoolTokenWithExpandedNesting,
    prismaPoolWithExpandedNesting,
    PrismaPoolWithExpandedNesting,
} from '../../../prisma/prisma-types';
import {
    GqlBalancePoolAprItem,
    GqlBalancePoolAprSubItem,
    GqlPoolDynamicData,
    GqlPoolFeaturedPoolGroup,
    GqlPoolFeaturedPool,
    GqlPoolGyro,
    GqlPoolInvestConfig,
    GqlPoolInvestOption,
    GqlPoolLinear,
    GqlPoolLinearNested,
    GqlPoolMinimal,
    GqlPoolNestingType,
    GqlPoolComposableStableNested,
    GqlPoolStaking,
    GqlPoolToken,
    GqlPoolTokenDisplay,
    GqlPoolTokenExpanded,
    GqlPoolTokenUnion,
    GqlPoolUnion,
    GqlPoolUserBalance,
    GqlPoolWithdrawConfig,
    GqlPoolWithdrawOption,
    QueryPoolGetPoolsArgs,
    GqlPoolFx,
} from '../../../schema';
import { isSameAddress } from '@balancer-labs/sdk';
import _ from 'lodash';
import { prisma } from '../../../prisma/prisma-client';
import { Chain, Prisma, PrismaPoolAprType, PrismaUserStakedBalance, PrismaUserWalletBalance } from '@prisma/client';
import { isWeightedPoolV2 } from './pool-utils';
import { oldBnum } from '../../big-number/old-big-number';
import { networkContext } from '../../network/network-context.service';
import { fixedNumber } from '../../view-helpers/fixed-number';
import { parseUnits } from 'ethers/lib/utils';
import { formatFixed } from '@ethersproject/bignumber';
import { BeethovenChainIds, chainToIdMap } from '../../network/network-config';
import { GithubContentService } from '../../content/github-content.service';
import { SanityContentService } from '../../content/sanity-content.service';
import { ElementData, FxData, GyroData, LinearData, StableData } from '../subgraph-mapper';

export class PoolGqlLoaderService {
    public async getPool(id: string, chain: Chain, userAddress?: string): Promise<GqlPoolUnion> {
        let pool = undefined;
        pool = await prisma.prismaPool.findUnique({
            where: { id_chain: { id, chain: chain } },
            include: {
                ...prismaPoolWithExpandedNesting.include,
                ...this.getUserBalancesInclude(userAddress),
            },
        });

        if (!pool) {
            throw new Error('Pool with id does not exist');
        }

        if (pool.type === 'UNKNOWN') {
            throw new Error('Pool exists, but has an unknown type');
        }

        return this.mapPoolToGqlPool(pool, pool.userWalletBalances, pool.userStakedBalances);
    }

    public async getPools(args: QueryPoolGetPoolsArgs): Promise<GqlPoolMinimal[]> {
        // only include wallet and staked balances if the query requests it
        // this makes sure that we don't load ALL user balances when we don't filter on userAddress
        // need to support ordering and paging by userbalanceUsd. Need to take care of that here, as the DB does not (and should not) store the usd balance
        if (args.where?.userAddress) {
            const first = args.first;
            const skip = args.skip ? args.skip : 0;
            if (args.orderBy === 'userbalanceUsd') {
                // we need to retrieve all pools, regardless of paging request as we can't page on a DB level because there is no balance usd stored
                args.first = undefined;
                args.skip = undefined;
            }
            const pools = await prisma.prismaPool.findMany({
                ...this.mapQueryArgsToPoolQuery(args),
                include: {
                    ...prismaPoolMinimal.include,
                    ...this.getUserBalancesInclude(args.where.userAddress),
                },
            });

            const gqlPools = pools.map((pool) =>
                this.mapToMinimalGqlPool(pool, pool.userWalletBalances, pool.userStakedBalances),
            );

            if (args.orderBy === 'userbalanceUsd') {
                let sortedPools = [];
                if (args.orderDirection === 'asc') {
                    sortedPools = gqlPools.sort(
                        (a, b) => a.userBalance!.totalBalanceUsd - b.userBalance!.totalBalanceUsd,
                    );
                } else {
                    sortedPools = gqlPools.sort(
                        (a, b) => b.userBalance!.totalBalanceUsd - a.userBalance!.totalBalanceUsd,
                    );
                }
                return first ? sortedPools.slice(skip, skip + first) : sortedPools.slice(skip, undefined);
            }

            return gqlPools;
        }

        const pools = await prisma.prismaPool.findMany({
            ...this.mapQueryArgsToPoolQuery(args),
            include: prismaPoolMinimal.include,
        });

        return pools.map((pool) => this.mapToMinimalGqlPool(pool));
    }

    public async getLinearPools(chains: Chain[]): Promise<GqlPoolLinear[]> {
        const pools = await prisma.prismaPool.findMany({
            where: { type: 'LINEAR', chain: { in: chains } },
            orderBy: { dynamicData: { totalLiquidity: 'desc' } },
            include: prismaPoolWithExpandedNesting.include,
        });

        return pools.map((pool) => this.mapPoolToGqlPool(pool)) as GqlPoolLinear[];
    }

    public async getGyroPools(chains: Chain[]): Promise<GqlPoolGyro[]> {
        const pools = await prisma.prismaPool.findMany({
            where: { type: { in: ['GYRO', 'GYRO3', 'GYROE'] }, chain: { in: chains } },
            orderBy: { dynamicData: { totalLiquidity: 'desc' } },
            include: prismaPoolWithExpandedNesting.include,
        });

        return pools.map((pool) => this.mapPoolToGqlPool(pool)) as GqlPoolGyro[];
    }

    public async getFxPools(chains: Chain[]): Promise<GqlPoolFx[]> {
        const pools = await prisma.prismaPool.findMany({
            where: { type: { in: ['FX'] }, chain: { in: chains } },
            orderBy: { dynamicData: { totalLiquidity: 'desc' } },
            include: prismaPoolWithExpandedNesting.include,
        });

        return pools.map((pool) => this.mapPoolToGqlPool(pool)) as GqlPoolFx[];
    }

    public mapToMinimalGqlPool(
        pool: PrismaPoolMinimal,
        userWalletbalances: PrismaUserWalletBalance[] = [],
        userStakedBalances: PrismaUserStakedBalance[] = [],
    ): GqlPoolMinimal {
        return {
            ...pool,
            decimals: 18,
            dynamicData: this.getPoolDynamicData(pool),
            allTokens: this.mapAllTokens(pool),
            displayTokens: this.mapDisplayTokens(pool),
            staking: this.getStakingData(pool),
            userBalance: this.getUserBalance(pool, userWalletbalances, userStakedBalances),
        };
    }

    public async getPoolsCount(args: QueryPoolGetPoolsArgs): Promise<number> {
        return prisma.prismaPool.count({ where: this.mapQueryArgsToPoolQuery(args).where });
    }

    public async getFeaturedPoolGroups(chains: Chain[]): Promise<GqlPoolFeaturedPoolGroup[]> {
        const featuredPoolGroups = [];
        if (chains.some((chain) => BeethovenChainIds.includes(chainToIdMap[chain]))) {
            const sanityContentService = new SanityContentService('FANTOM');
            featuredPoolGroups.push(...(await sanityContentService.getFeaturedPoolGroups(chains)));
        }
        const poolIds = featuredPoolGroups
            .map((group) =>
                group.items
                    .filter((item) => item._type === 'homeScreenFeaturedPoolGroupPoolId')
                    .map((item) => (item._type === 'homeScreenFeaturedPoolGroupPoolId' ? item.poolId : '')),
            )
            .flat();

        const pools = await this.getPools({ where: { idIn: poolIds } });

        return featuredPoolGroups.map((group) => {
            return {
                ...group,
                items: group.items
                    //filter out any invalid pool ids
                    .filter((item) => {
                        if (item._type === 'homeScreenFeaturedPoolGroupPoolId') {
                            return !!pools.find((pool) => pool.id === item.poolId);
                        }

                        return true;
                    })
                    .map((item) => {
                        if (item._type === 'homeScreenFeaturedPoolGroupPoolId') {
                            const pool = pools.find((pool) => pool.id === item.poolId);

                            return { __typename: 'GqlPoolMinimal', ...pool! };
                        } else {
                            return { __typename: 'GqlFeaturePoolGroupItemExternalLink', ...item };
                        }
                    }),
            };
        });
    }

    public async getFeaturedPools(chains: Chain[]): Promise<GqlPoolFeaturedPool[]> {
        const githubContentService = new GithubContentService();
        const featuredPoolsFromService = await githubContentService.getFeaturedPools(chains);

        const featuredPools: GqlPoolFeaturedPool[] = [];

        for (const contentPool of featuredPoolsFromService) {
            const pool = await this.getPool(contentPool.poolId.toLowerCase(), contentPool.chain);
            featuredPools.push({
                poolId: contentPool.poolId,
                primary: contentPool.primary,
                pool: pool,
            });
        }

        return featuredPools;
    }

    private mapQueryArgsToPoolQuery(args: QueryPoolGetPoolsArgs): Prisma.PrismaPoolFindManyArgs {
        let orderBy: Prisma.PrismaPoolOrderByWithRelationInput = {};
        const orderDirection = args.orderDirection || undefined;
        const userAddress = args.where?.userAddress;

        switch (args.orderBy) {
            case 'totalLiquidity':
                orderBy = { dynamicData: { totalLiquidity: orderDirection } };
                break;
            case 'totalShares':
                orderBy = { dynamicData: { totalShares: orderDirection } };
                break;
            case 'volume24h':
                orderBy = { dynamicData: { volume24h: orderDirection } };
                break;
            case 'fees24h':
                orderBy = { dynamicData: { fees24h: orderDirection } };
                break;
            case 'apr':
                orderBy = { dynamicData: { apr: orderDirection } };
                break;
        }

        const baseQuery: Prisma.PrismaPoolFindManyArgs = {
            take: args.first || undefined,
            skip: args.skip || undefined,
            orderBy,
        };

        if (!args.where && !args.textSearch) {
            return {
                ...baseQuery,
                where: {
                    categories: {
                        none: { category: 'BLACK_LISTED' },
                    },
                    dynamicData: {
                        totalSharesNum: {
                            gt: 0.000000000001,
                        },
                    },
                },
            };
        }

        const where = args.where;
        const textSearch = args.textSearch ? { contains: args.textSearch, mode: 'insensitive' as const } : undefined;

        const allTokensFilter = [];
        where?.tokensIn?.forEach((token) => {
            allTokensFilter.push({
                allTokens: {
                    some: {
                        token: {
                            address: {
                                equals: token,
                                mode: 'insensitive' as const,
                            },
                        },
                    },
                },
            });
        });

        if (where?.tokensNotIn) {
            allTokensFilter.push({
                allTokens: {
                    every: {
                        token: {
                            address: {
                                notIn: where.tokensNotIn || undefined,
                                mode: 'insensitive' as const,
                            },
                        },
                    },
                },
            });
        }

        const userArgs: Prisma.PrismaPoolWhereInput = userAddress
            ? {
                  OR: [
                      {
                          userWalletBalances: {
                              some: {
                                  userAddress: {
                                      equals: userAddress,
                                      mode: 'insensitive' as const,
                                  },
                                  balanceNum: { gt: 0 },
                              },
                          },
                      },
                      {
                          userStakedBalances: {
                              some: {
                                  userAddress: {
                                      equals: userAddress,
                                      mode: 'insensitive' as const,
                                  },
                                  balanceNum: { gt: 0 },
                              },
                          },
                      },
                  ],
              }
            : {};

        const filterArgs: Prisma.PrismaPoolWhereInput = {
            dynamicData: {
                totalSharesNum: {
                    gt: 0.000000000001,
                },
            },
            chain: {
                in: where?.chainIn || undefined,
                notIn: where?.chainNotIn || undefined,
            },
            vaultVersion: {
                in: where?.vaultVersionIn || undefined,
            },
            type: {
                in: where?.poolTypeIn || undefined,
                notIn: where?.poolTypeNotIn || undefined,
            },
            createTime: {
                gt: where?.createTime?.gt || undefined,
                lt: where?.createTime?.lt || undefined,
            },
            AND: allTokensFilter,
            id: {
                in: where?.idIn || undefined,
                notIn: where?.idNotIn || undefined,
                mode: 'insensitive',
            },
            categories: {
                ...(where?.categoryNotIn
                    ? {
                          every: {
                              category: {
                                  notIn: where.categoryNotIn,
                              },
                          },
                      }
                    : {}),
                ...(where?.categoryIn
                    ? {
                          some: {
                              category: {
                                  in: where.categoryIn,
                              },
                          },
                      }
                    : {}),
            },
            filters: {
                ...(where?.filterNotIn
                    ? {
                          every: {
                              filterId: {
                                  notIn: where.filterNotIn,
                              },
                          },
                      }
                    : {}),
                ...(where?.filterIn
                    ? {
                          some: {
                              filterId: {
                                  in: where.filterIn,
                              },
                          },
                      }
                    : {}),
            },
        };

        if (!textSearch) {
            return {
                ...baseQuery,
                where: {
                    ...filterArgs,
                    ...userArgs,
                },
            };
        }

        return {
            ...baseQuery,
            where: {
                OR: [
                    { name: textSearch, ...filterArgs, ...userArgs },
                    { symbol: textSearch, ...filterArgs, ...userArgs },
                    {
                        ...filterArgs,
                        ...userArgs,
                        allTokens: {
                            some: {
                                OR: [
                                    {
                                        token: {
                                            name: textSearch,
                                            address: filterArgs.allTokens?.some?.token?.address,
                                        },
                                    },
                                    {
                                        token: {
                                            symbol: textSearch,
                                            address: filterArgs.allTokens?.some?.token?.address,
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
            },
        };
    }

    private mapPoolToGqlPool(
        pool: PrismaPoolWithExpandedNesting,
        userWalletbalances: PrismaUserWalletBalance[] = [],
        userStakedBalances: PrismaUserStakedBalance[] = [],
    ): GqlPoolUnion {
        const { typeData, ...poolWithoutTypeData } = pool;

        const bpt = pool.tokens.find((token) => token.address === pool.address);

        const mappedData = {
            decimals: 18,
            staking: this.getStakingData(pool),
            dynamicData: this.getPoolDynamicData(pool),
            investConfig: this.getPoolInvestConfig(pool),
            withdrawConfig: this.getPoolWithdrawConfig(pool),
            nestingType: this.getPoolNestingType(pool),
            tokens: pool.tokens.map((token) => this.mapPoolTokenToGqlUnion(token)),
            allTokens: this.mapAllTokens(pool),
            displayTokens: this.mapDisplayTokens(pool),
            userBalance: this.getUserBalance(pool, userWalletbalances, userStakedBalances),
        };

        //TODO: may need to build out the types here still
        switch (pool.type) {
            case 'STABLE':
                return {
                    __typename: 'GqlPoolStable',
                    ...poolWithoutTypeData,
                    ...(typeData as StableData),
                    ...mappedData,
                    tokens: mappedData.tokens as GqlPoolToken[],
                };
            case 'META_STABLE':
                return {
                    __typename: 'GqlPoolMetaStable',
                    ...poolWithoutTypeData,
                    ...(typeData as StableData),
                    ...mappedData,
                    tokens: mappedData.tokens as GqlPoolToken[],
                };
            case 'COMPOSABLE_STABLE':
                return {
                    __typename: 'GqlPoolComposableStable',
                    ...poolWithoutTypeData,
                    ...(typeData as StableData),
                    ...mappedData,
                    bptPriceRate: bpt?.dynamicData?.priceRate || '1.0',
                };
            case 'LINEAR':
                return {
                    __typename: 'GqlPoolLinear',
                    ...poolWithoutTypeData,
                    ...(typeData as LinearData),
                    ...mappedData,
                    tokens: mappedData.tokens as GqlPoolToken[],
                    bptPriceRate: bpt?.dynamicData?.priceRate || '1.0',
                };
            case 'ELEMENT':
                return {
                    __typename: 'GqlPoolElement',
                    ...poolWithoutTypeData,
                    ...(typeData as ElementData),
                    ...mappedData,
                    tokens: mappedData.tokens as GqlPoolToken[],
                };
            case 'LIQUIDITY_BOOTSTRAPPING':
                return {
                    __typename: 'GqlPoolLiquidityBootstrapping',
                    ...poolWithoutTypeData,
                    ...mappedData,
                };
            case 'GYRO':
            case 'GYRO3':
            case 'GYROE':
                return {
                    __typename: 'GqlPoolGyro',
                    ...poolWithoutTypeData,
                    ...(typeData as GyroData),
                    ...mappedData,
                };
            case 'FX':
                return {
                    __typename: 'GqlPoolFx',
                    ...poolWithoutTypeData,
                    ...mappedData,
                    ...(typeData as FxData),
                };
        }

        return {
            __typename: 'GqlPoolWeighted',
            ...poolWithoutTypeData,
            ...mappedData,
        };
    }

    private mapAllTokens(pool: PrismaPoolMinimal): GqlPoolTokenExpanded[] {
        return pool.allTokens.map((token) => {
            const poolToken = pool.tokens.find((poolToken) => poolToken.address === token.token.address);
            const isNested = !poolToken;
            const isPhantomBpt = token.tokenAddress === pool.address;
            const isMainToken = !token.token.types.some(
                (type) => type.type === 'LINEAR_WRAPPED_TOKEN' || type.type === 'PHANTOM_BPT' || type.type === 'BPT',
            );

            return {
                ...token.token,
                id: `${pool.id}-${token.tokenAddress}`,
                weight: poolToken?.dynamicData?.weight,
                isNested,
                isPhantomBpt,
                isMainToken,
            };
        });
    }

    private mapDisplayTokens(pool: PrismaPoolMinimal): GqlPoolTokenDisplay[] {
        return pool.tokens
            .filter((token) => token.address !== pool.address)
            .map((poolToken) => {
                const allToken = pool.allTokens.find((allToken) => allToken.token.address === poolToken.address)!;

                if (allToken.nestedPool?.type === 'LINEAR') {
                    const mainToken = allToken.nestedPool.allTokens.find(
                        (nestedToken) =>
                            !nestedToken.token.types.some(
                                (type) =>
                                    type.type === 'LINEAR_WRAPPED_TOKEN' ||
                                    type.type === 'PHANTOM_BPT' ||
                                    type.type === 'BPT',
                            ),
                    );

                    if (mainToken) {
                        return {
                            id: `${pool.id}-${mainToken.token.address}`,
                            ...mainToken.token,
                            weight: poolToken?.dynamicData?.weight,
                        };
                    }
                } else if (allToken.nestedPool?.type === 'COMPOSABLE_STABLE') {
                    const mainTokens =
                        allToken.nestedPool.allTokens.filter(
                            (nestedToken) =>
                                !nestedToken.token.types.some(
                                    (type) =>
                                        type.type === 'LINEAR_WRAPPED_TOKEN' ||
                                        type.type === 'PHANTOM_BPT' ||
                                        type.type === 'BPT',
                                ),
                        ) || [];

                    return {
                        id: `${pool.id}-${poolToken.token.address}`,
                        ...poolToken.token,
                        weight: poolToken?.dynamicData?.weight,
                        nestedTokens: mainTokens.map((mainToken) => ({
                            id: `${pool.id}-${poolToken.token.address}-${mainToken.tokenAddress}`,
                            ...mainToken.token,
                        })),
                    };
                }

                return {
                    id: `${pool.id}-${poolToken.token.address}`,
                    ...poolToken.token,
                    weight: poolToken?.dynamicData?.weight,
                };
            });
    }

    private getStakingData(pool: PrismaPoolMinimal): GqlPoolStaking | null {
        if (pool.staking.length === 0) {
            return null;
        }

        for (const staking of pool.staking) {
            // This is needed to cast type APR type of the reliquary level from prisma (float) to the type of GQL (bigdecimal/string)
            if (staking.reliquary) {
                return {
                    ...staking,
                    reliquary: {
                        ...staking.reliquary,
                        levels: staking.reliquary.levels.map((level) => ({
                            ...level,
                            apr: `${level.apr}`,
                        })),
                    },
                };
            } else if (staking.farm) {
                return {
                    ...staking,
                    gauge: null,
                    reliquary: null,
                };
            }
        }

        const sorted = _.sortBy(pool.staking, (staking) => {
            if (staking.gauge) {
                switch (staking.gauge.status) {
                    case 'PREFERRED':
                        return 0;
                    case 'ACTIVE':
                        return 1;
                    case 'KILLED':
                        return 2;
                }
            }

            return 100;
        }).filter((staking) => staking.gauge);

        return {
            ...sorted[0],
            gauge: {
                ...sorted[0].gauge!,
                otherGauges: sorted.slice(1).map((item) => item.gauge!),
            },
            farm: null,
            reliquary: null,
        };
    }

    private getUserBalance(
        pool: PrismaPoolMinimal,
        userWalletBalances: PrismaUserWalletBalance[],
        userStakedBalances: PrismaUserStakedBalance[],
    ): GqlPoolUserBalance {
        let bptPrice = 0;
        if (pool.dynamicData && pool.dynamicData.totalLiquidity > 0 && parseFloat(pool.dynamicData.totalShares) > 0) {
            bptPrice = pool.dynamicData.totalLiquidity / parseFloat(pool.dynamicData.totalShares);
        }

        const walletBalance = parseUnits(userWalletBalances.at(0)?.balance || '0', 18);
        const stakedBalance = parseUnits(userStakedBalances.at(0)?.balance || '0', 18);
        const walletBalanceNum = userWalletBalances.at(0)?.balanceNum || 0;
        const stakedBalanceNum = userStakedBalances.at(0)?.balanceNum || 0;

        return {
            walletBalance: userWalletBalances.at(0)?.balance || '0',
            stakedBalance: userStakedBalances.at(0)?.balance || '0',
            totalBalance: formatFixed(stakedBalance.add(walletBalance), 18),
            walletBalanceUsd: walletBalanceNum * bptPrice,
            stakedBalanceUsd: stakedBalanceNum * bptPrice,
            totalBalanceUsd: (walletBalanceNum + stakedBalanceNum) * bptPrice,
        };
    }

    private getPoolDynamicData(pool: PrismaPoolMinimal): GqlPoolDynamicData {
        const {
            fees24h,
            totalLiquidity,
            volume24h,
            fees48h,
            volume48h,
            yieldCapture24h,
            yieldCapture48h,
            totalLiquidity24hAgo,
            totalShares24hAgo,
            lifetimeVolume,
            lifetimeSwapFees,
            holdersCount,
            swapsCount,
            sharePriceAth,
            sharePriceAthTimestamp,
            sharePriceAtl,
            sharePriceAtlTimestamp,
            totalLiquidityAth,
            totalLiquidityAthTimestamp,
            totalLiquidityAtl,
            totalLiquidityAtlTimestamp,
            volume24hAtl,
            volume24hAthTimestamp,
            volume24hAth,
            volume24hAtlTimestamp,
            fees24hAtl,
            fees24hAthTimestamp,
            fees24hAth,
            fees24hAtlTimestamp,
        } = pool.dynamicData!;
        const aprItems = pool.aprItems?.filter((item) => item.apr > 0 || (item.range?.max ?? 0 > 0)) || [];
        const swapAprItems = aprItems.filter((item) => item.type == 'SWAP_FEE');

        // swap apr cannot have a range, so we can already sum it up
        const aprItemsWithNoGroup = aprItems.filter((item) => !item.group);

        const hasAprRange = !!aprItems.find((item) => item.range);
        let aprTotal = `0`;
        let swapAprTotal = `0`;
        let nativeRewardAprTotal = `0`;
        let thirdPartyAprTotal = `0`;

        let aprRangeMin: string | undefined;
        let aprRangeMax: string | undefined;

        let nativeAprRangeMin: string | undefined;
        let nativeAprRangeMax: string | undefined;

        let thirdPartyAprRangeMin: string | undefined;
        let thirdPartyAprRangeMax: string | undefined;

        let hasRewardApr = false;

        // It is likely that if either native or third party APR has a range, that both of them have a range
        // therefore if there is a least one item with a range, we show both rewards in a range, although min and max might be identical
        if (hasAprRange) {
            let swapFeeApr = 0;
            let currentAprRangeMinTotal = 0;
            let currentAprRangeMaxTotal = 0;
            let currentNativeAprRangeMin = 0;
            let currentNativeAprRangeMax = 0;
            let currentThirdPartyAprRangeMin = 0;
            let currentThirdPartyAprRangeMax = 0;

            for (let aprItem of aprItems) {
                let minApr: number;
                let maxApr: number;

                if (aprItem.range) {
                    minApr = aprItem.range.min;
                    maxApr = aprItem.range.max;
                } else {
                    minApr = aprItem.apr;
                    maxApr = aprItem.apr;
                }

                currentAprRangeMinTotal += minApr;
                currentAprRangeMaxTotal += maxApr;

                switch (aprItem.type) {
                    case PrismaPoolAprType.NATIVE_REWARD: {
                        currentNativeAprRangeMin += minApr;
                        currentNativeAprRangeMax += maxApr;
                        break;
                    }
                    case PrismaPoolAprType.THIRD_PARTY_REWARD: {
                        currentThirdPartyAprRangeMin += minApr;
                        currentThirdPartyAprRangeMax += maxApr;
                        break;
                    }
                    case PrismaPoolAprType.VOTING: {
                        currentThirdPartyAprRangeMin += minApr;
                        currentThirdPartyAprRangeMax += maxApr;
                        break;
                    }
                    case 'SWAP_FEE': {
                        swapFeeApr += maxApr;
                        break;
                    }
                }
            }
            swapAprTotal = `${swapFeeApr}`;
            aprRangeMin = `${currentAprRangeMinTotal}`;
            aprRangeMax = `${currentAprRangeMaxTotal}`;
            nativeAprRangeMin = `${currentNativeAprRangeMin}`;
            nativeAprRangeMax = `${currentNativeAprRangeMax}`;
            thirdPartyAprRangeMin = `${currentThirdPartyAprRangeMin}`;
            thirdPartyAprRangeMax = `${currentThirdPartyAprRangeMax}`;
            hasRewardApr = currentNativeAprRangeMax > 0 || currentThirdPartyAprRangeMax > 0;
        } else {
            const nativeRewardAprItems = aprItems.filter((item) => item.type === 'NATIVE_REWARD');
            const thirdPartyRewardAprItems = aprItems.filter((item) => item.type === 'THIRD_PARTY_REWARD');
            aprTotal = `${_.sumBy(aprItems, 'apr')}`;
            swapAprTotal = `${_.sumBy(swapAprItems, 'apr')}`;
            nativeRewardAprTotal = `${_.sumBy(nativeRewardAprItems, 'apr')}`;
            thirdPartyAprTotal = `${_.sumBy(thirdPartyRewardAprItems, 'apr')}`;
            hasRewardApr = nativeRewardAprItems.length > 0 || thirdPartyRewardAprItems.length > 0;
        }

        const grouped = _.groupBy(
            aprItems.filter((item) => item.group),
            (item) => item.group,
        );

        return {
            ...pool.dynamicData!,
            totalLiquidity: `${fixedNumber(totalLiquidity, 2)}`,
            totalLiquidity24hAgo: `${fixedNumber(totalLiquidity24hAgo, 2)}`,
            totalShares24hAgo,
            fees24h: `${fixedNumber(fees24h, 2)}`,
            volume24h: `${fixedNumber(volume24h, 2)}`,
            yieldCapture24h: `${fixedNumber(yieldCapture24h, 2)}`,
            yieldCapture48h: `${fixedNumber(yieldCapture48h, 2)}`,
            fees48h: `${fixedNumber(fees48h, 2)}`,
            volume48h: `${fixedNumber(volume48h, 2)}`,
            lifetimeVolume: `${fixedNumber(lifetimeVolume, 2)}`,
            lifetimeSwapFees: `${fixedNumber(lifetimeSwapFees, 2)}`,
            holdersCount: `${holdersCount}`,
            swapsCount: `${swapsCount}`,
            sharePriceAth: `${sharePriceAth}`,
            sharePriceAtl: `${sharePriceAtl}`,
            totalLiquidityAth: `${fixedNumber(totalLiquidityAth, 2)}`,
            totalLiquidityAtl: `${fixedNumber(totalLiquidityAtl, 2)}`,
            volume24hAtl: `${fixedNumber(volume24hAtl, 2)}`,
            volume24hAth: `${fixedNumber(volume24hAth, 2)}`,
            fees24hAtl: `${fixedNumber(fees24hAtl, 2)}`,
            fees24hAth: `${fixedNumber(fees24hAth, 2)}`,
            sharePriceAthTimestamp,
            sharePriceAtlTimestamp,
            totalLiquidityAthTimestamp,
            totalLiquidityAtlTimestamp,
            fees24hAthTimestamp,
            fees24hAtlTimestamp,
            volume24hAthTimestamp,
            volume24hAtlTimestamp,
            apr: {
                apr:
                    typeof aprRangeMin !== 'undefined' && typeof aprRangeMax !== 'undefined'
                        ? {
                              __typename: 'GqlPoolAprRange',
                              min: aprRangeMin,
                              max: aprRangeMax,
                          }
                        : { __typename: 'GqlPoolAprTotal', total: aprTotal },
                swapApr: swapAprTotal,
                nativeRewardApr:
                    typeof nativeAprRangeMin !== 'undefined' && typeof nativeAprRangeMax !== 'undefined'
                        ? {
                              __typename: 'GqlPoolAprRange',
                              min: nativeAprRangeMin,
                              max: nativeAprRangeMax,
                          }
                        : { __typename: 'GqlPoolAprTotal', total: nativeRewardAprTotal },
                thirdPartyApr:
                    typeof thirdPartyAprRangeMin !== 'undefined' && typeof thirdPartyAprRangeMax !== 'undefined'
                        ? {
                              __typename: 'GqlPoolAprRange',
                              min: thirdPartyAprRangeMin,
                              max: thirdPartyAprRangeMax,
                          }
                        : { __typename: 'GqlPoolAprTotal', total: thirdPartyAprTotal },
                items: [
                    ...aprItemsWithNoGroup.flatMap((item): GqlBalancePoolAprItem[] => {
                        if (item.range) {
                            return [
                                {
                                    id: item.id,
                                    apr: {
                                        __typename: 'GqlPoolAprRange',
                                        min: item.range.min.toString(),
                                        max: item.range.max.toString(),
                                    },
                                    title: item.title,
                                    subItems: [],
                                },
                            ];
                        } else {
                            return [
                                {
                                    ...item,
                                    apr: { __typename: 'GqlPoolAprTotal', total: `${item.apr}` },
                                    subItems: [],
                                },
                            ];
                        }
                    }),
                    ..._.map(grouped, (items, group): GqlBalancePoolAprItem => {
                        // todo: might need to support apr ranges as well at some point
                        const subItems = items.map(
                            (item): GqlBalancePoolAprSubItem => ({
                                ...item,
                                apr: { __typename: 'GqlPoolAprTotal', total: `${item.apr}` },
                            }),
                        );
                        const apr = _.sumBy(items, 'apr');
                        const title = `${group.charAt(0) + group.slice(1).toLowerCase()} boosted APR`;

                        return {
                            id: `${pool.id}-${group}`,
                            title,
                            apr: { __typename: 'GqlPoolAprTotal', total: `${apr}` },
                            subItems,
                        };
                    }),
                ],
                hasRewardApr,
            },
        };
    }

    private getPoolInvestConfig(pool: PrismaPoolWithExpandedNesting): GqlPoolInvestConfig {
        const poolTokens = pool.tokens.filter((token) => token.address !== pool.address);
        const supportsNativeAssetDeposit = pool.type !== 'COMPOSABLE_STABLE';
        let options: GqlPoolInvestOption[] = [];

        for (const poolToken of poolTokens) {
            options = [...options, ...this.getActionOptionsForPoolToken(pool, poolToken, supportsNativeAssetDeposit)];
        }

        return {
            //TODO could flag these as disabled in sanity
            proportionalEnabled: pool.type !== 'COMPOSABLE_STABLE' && pool.type !== 'META_STABLE',
            singleAssetEnabled: true,
            options,
        };
    }

    private getPoolWithdrawConfig(pool: PrismaPoolWithExpandedNesting): GqlPoolWithdrawConfig {
        const poolTokens = pool.tokens.filter((token) => token.address !== pool.address);
        let options: GqlPoolWithdrawOption[] = [];

        for (const poolToken of poolTokens) {
            options = [...options, ...this.getActionOptionsForPoolToken(pool, poolToken, false, true)];
        }

        return {
            //TODO could flag these as disabled in sanity
            proportionalEnabled: true,
            singleAssetEnabled: true,
            options,
        };
    }

    private getActionOptionsForPoolToken(
        pool: PrismaPoolWithExpandedNesting,
        poolToken: PrismaPoolTokenWithExpandedNesting,
        supportsNativeAsset: boolean,
        isWithdraw?: boolean,
    ): { poolTokenAddress: string; poolTokenIndex: number; tokenOptions: GqlPoolToken[] }[] {
        const nestedPool = poolToken.nestedPool;
        const options: GqlPoolInvestOption[] = [];

        if (nestedPool && nestedPool.type === 'LINEAR' && (nestedPool.typeData as LinearData).mainIndex !== undefined) {
            const mainToken = nestedPool.tokens[(nestedPool.typeData as LinearData).mainIndex];
            const isWrappedNativeAsset = isSameAddress(mainToken.address, networkContext.data.weth.address);

            options.push({
                poolTokenIndex: poolToken.index,
                poolTokenAddress: poolToken.address,
                tokenOptions:
                    //TODO: will be good to add support for depositing the wrapped token for the linear pool
                    isWrappedNativeAsset && supportsNativeAsset
                        ? [
                              this.mapPoolTokenToGql(mainToken),
                              this.mapPoolTokenToGql({
                                  ...mainToken,
                                  token: {
                                      ...poolToken.token,
                                      symbol: networkContext.data.eth.symbol,
                                      address: networkContext.data.eth.address,
                                      name: networkContext.data.eth.name,
                                  },
                                  id: `${pool.id}-${networkContext.data.eth.address}`,
                              }),
                          ]
                        : [this.mapPoolTokenToGql(mainToken)],
            });
        } else if (nestedPool && nestedPool.type === 'COMPOSABLE_STABLE') {
            const nestedTokens = nestedPool.tokens.filter((token) => token.address !== nestedPool.address);

            if (pool.type === 'COMPOSABLE_STABLE' || isWeightedPoolV2(pool)) {
                //when nesting a composable stable inside a composable stable, all of the underlying tokens can be used when investing
                //when withdrawing from a v2 weighted pool, we withdraw into all underlying assets.
                // ie: USDC/DAI/USDT for nested bbaUSD
                for (const nestedToken of nestedTokens) {
                    options.push({
                        poolTokenIndex: poolToken.index,
                        poolTokenAddress: poolToken.address,
                        tokenOptions:
                            nestedToken.nestedPool &&
                            nestedToken.nestedPool.type === 'LINEAR' &&
                            (nestedToken.nestedPool.typeData as LinearData).mainIndex !== undefined
                                ? [
                                      this.mapPoolTokenToGql(
                                          nestedToken.nestedPool.tokens[
                                              (nestedToken.nestedPool.typeData as LinearData).mainIndex
                                          ],
                                      ),
                                  ]
                                : [this.mapPoolTokenToGql(nestedToken)],
                    });
                }
            } else {
                //if the parent pool does not have phantom bpt (ie: weighted), the user can only invest with 1 of the composable stable tokens
                options.push({
                    poolTokenIndex: poolToken.index,
                    poolTokenAddress: poolToken.address,
                    tokenOptions: nestedTokens.map((nestedToken) => {
                        if (
                            nestedToken.nestedPool &&
                            nestedToken.nestedPool.type === 'LINEAR' &&
                            (nestedToken.nestedPool.typeData as LinearData).mainIndex !== undefined
                        ) {
                            return this.mapPoolTokenToGql(
                                nestedToken.nestedPool.tokens[
                                    (nestedToken.nestedPool.typeData as LinearData).mainIndex
                                ],
                            );
                        }

                        return this.mapPoolTokenToGql(nestedToken);
                    }),
                });
            }
        } else {
            const isWrappedNativeAsset = isSameAddress(poolToken.address, networkContext.data.weth.address);

            options.push({
                poolTokenIndex: poolToken.index,
                poolTokenAddress: poolToken.address,
                tokenOptions:
                    isWrappedNativeAsset && supportsNativeAsset
                        ? [
                              this.mapPoolTokenToGql(poolToken),
                              this.mapPoolTokenToGql({
                                  ...poolToken,
                                  token: {
                                      ...poolToken.token,
                                      symbol: networkContext.data.eth.symbol,
                                      address: networkContext.data.eth.address,
                                      name: networkContext.data.eth.name,
                                  },
                                  id: `${pool.id}-${networkContext.data.eth.address}`,
                              }),
                          ]
                        : [this.mapPoolTokenToGql(poolToken)],
            });
        }

        return options;
    }

    private mapPoolTokenToGqlUnion(token: PrismaPoolTokenWithExpandedNesting): GqlPoolTokenUnion {
        const { nestedPool } = token;

        if (nestedPool && nestedPool.type === 'LINEAR') {
            const totalShares = parseFloat(nestedPool.dynamicData?.totalShares || '0');
            const percentOfSupplyNested =
                totalShares > 0 ? parseFloat(token.dynamicData?.balance || '0') / totalShares : 0;

            return {
                ...this.mapPoolTokenToGql(token),
                __typename: 'GqlPoolTokenLinear',
                ...this.getLinearPoolTokenData(token, nestedPool),
                pool: this.mapNestedPoolToGqlPoolLinearNested(nestedPool, percentOfSupplyNested),
            };
        } else if (nestedPool && nestedPool.type === 'COMPOSABLE_STABLE') {
            const totalShares = parseFloat(nestedPool.dynamicData?.totalShares || '0');
            const percentOfSupplyNested =
                totalShares > 0 ? parseFloat(token.dynamicData?.balance || '0') / totalShares : 0;

            //50_000_000_000_000
            return {
                ...this.mapPoolTokenToGql(token),
                __typename: 'GqlPoolTokenComposableStable',
                pool: this.mapNestedPoolToGqlPoolComposableStableNested(nestedPool, percentOfSupplyNested),
            };
        }

        return this.mapPoolTokenToGql(token);
    }

    private mapPoolTokenToGql(poolToken: PrismaPoolTokenWithDynamicData): GqlPoolToken {
        return {
            id: poolToken.id,
            ...poolToken.token,
            __typename: 'GqlPoolToken',
            priceRate: poolToken.dynamicData?.priceRate || '1.0',
            priceRateProvider: poolToken.priceRateProvider,
            balance: poolToken.dynamicData?.balance || '0',
            index: poolToken.index,
            weight: poolToken.dynamicData?.weight,
            totalBalance: poolToken.dynamicData?.balance || '0',
        };
    }

    private mapNestedPoolToGqlPoolLinearNested(
        pool: PrismaNestedPoolWithNoNesting,
        percentOfSupplyNested: number,
    ): GqlPoolLinearNested {
        const totalLiquidity = pool.dynamicData?.totalLiquidity || 0;
        const bpt = pool.tokens.find((token) => token.address === pool.address);

        return {
            __typename: 'GqlPoolLinearNested',
            ...pool,
            ...(pool.typeData as LinearData)!,
            tokens: pool.tokens
                .filter((token) => token.address !== pool.address)
                .map((token) => {
                    return {
                        ...this.mapPoolTokenToGql({
                            ...token,
                            dynamicData: token.dynamicData
                                ? {
                                      ...token.dynamicData,
                                      balance: `${parseFloat(token.dynamicData.balance) * percentOfSupplyNested}`,
                                  }
                                : null,
                        }),
                        totalBalance: token.dynamicData?.balance || '0',
                    };
                }),
            totalLiquidity: `${totalLiquidity}`,
            totalShares: pool.dynamicData?.totalShares || '0',
            bptPriceRate: bpt?.dynamicData?.priceRate || '1.0',
        };
    }

    private mapNestedPoolToGqlPoolComposableStableNested(
        pool: PrismaNestedPoolWithSingleLayerNesting,
        percentOfSupplyNested: number,
    ): GqlPoolComposableStableNested {
        const bpt = pool.tokens.find((token) => token.address === pool.address);

        return {
            __typename: 'GqlPoolComposableStableNested',
            ...pool,
            ...(pool.typeData as StableData)!,
            nestingType: this.getPoolNestingType(pool),
            tokens: pool.tokens.map((token) => {
                const nestedPool = token.nestedPool;

                if (nestedPool && nestedPool.type === 'LINEAR') {
                    const totalShares = parseFloat(nestedPool.dynamicData?.totalShares || '0');
                    const percentOfLinearSupplyNested =
                        totalShares > 0 ? parseFloat(token.dynamicData?.balance || '0') / totalShares : 0;

                    return {
                        ...this.mapPoolTokenToGql({
                            ...token,
                            dynamicData: token.dynamicData
                                ? {
                                      ...token.dynamicData,
                                      balance: `${parseFloat(token.dynamicData.balance) * percentOfSupplyNested}`,
                                  }
                                : null,
                        }),
                        __typename: 'GqlPoolTokenLinear',
                        ...this.getLinearPoolTokenData(token, nestedPool),
                        pool: this.mapNestedPoolToGqlPoolLinearNested(
                            nestedPool,
                            percentOfSupplyNested * percentOfLinearSupplyNested,
                        ),
                        totalBalance: token.dynamicData?.balance || '0',
                    };
                }

                return this.mapPoolTokenToGql(token);
            }),
            totalLiquidity: `${pool.dynamicData?.totalLiquidity || 0}`,
            totalShares: pool.dynamicData?.totalShares || '0',
            swapFee: pool.dynamicData?.swapFee || '0',
            bptPriceRate: bpt?.dynamicData?.priceRate || '1.0',
        };
    }

    private getPoolNestingType(pool: PrismaNestedPoolWithSingleLayerNesting): GqlPoolNestingType {
        const tokens = pool.tokens.filter((token) => token.address !== pool.address);
        const numTokensWithNestedPool = tokens.filter((token) => !!token.nestedPool).length;

        if (numTokensWithNestedPool === tokens.length) {
            return 'HAS_ONLY_PHANTOM_BPT';
        } else if (numTokensWithNestedPool > 0) {
            return 'HAS_SOME_PHANTOM_BPT';
        }

        return 'NO_NESTING';
    }

    private getLinearPoolTokenData(
        poolToken: PrismaPoolTokenWithDynamicData,
        nestedPool: PrismaNestedPoolWithNoNesting,
    ): {
        mainTokenBalance: string;
        wrappedTokenBalance: string;
        totalMainTokenBalance: string;
    } {
        if (!poolToken.dynamicData || !(nestedPool.typeData as LinearData) || !nestedPool.dynamicData) {
            return {
                mainTokenBalance: '0',
                wrappedTokenBalance: '0',
                totalMainTokenBalance: '0',
            };
        }

        const percentOfSupplyInPool =
            parseFloat(poolToken.dynamicData.balance) / parseFloat(nestedPool.dynamicData.totalShares);

        const mainToken = nestedPool.tokens[(nestedPool.typeData as LinearData).mainIndex];
        const wrappedToken = nestedPool.tokens[(nestedPool.typeData as LinearData).wrappedIndex];

        const wrappedTokenBalance = oldBnum(wrappedToken.dynamicData?.balance || '0').times(percentOfSupplyInPool);
        const mainTokenBalance = oldBnum(mainToken.dynamicData?.balance || '0').times(percentOfSupplyInPool);

        return {
            mainTokenBalance: `${mainTokenBalance.toFixed(mainToken.token.decimals)}`,
            wrappedTokenBalance: `${wrappedTokenBalance.toFixed(wrappedToken.token.decimals)}`,
            totalMainTokenBalance: `${mainTokenBalance
                .plus(wrappedTokenBalance.times(wrappedToken.dynamicData?.priceRate || '1'))
                .toFixed(mainToken.token.decimals)}`,
        };
    }

    private getUserBalancesInclude(userAddress?: string) {
        if (!userAddress) {
            return {};
        }
        return {
            userWalletBalances: {
                where: {
                    userAddress: {
                        equals: userAddress,
                        mode: 'insensitive' as const,
                    },
                    balanceNum: { gt: 0 },
                },
            },
            userStakedBalances: {
                where: {
                    userAddress: {
                        equals: userAddress,
                        mode: 'insensitive' as const,
                    },
                    balanceNum: { gt: 0 },
                },
            },
        };
    }
}
