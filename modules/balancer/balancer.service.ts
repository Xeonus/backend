import { balancerSubgraphService } from '../balancer-subgraph/balancer-subgraph.service';
import {
    BalancerLatestPriceFragment,
    BalancerPoolFragment,
    BalancerTradePairSnapshotFragment,
    JoinExit_OrderBy,
    OrderDirection,
    Pool_OrderBy,
    TradePairSnapshot_OrderBy,
} from '../balancer-subgraph/generated/balancer-subgraph-types';
import { sanityClient } from '../sanity/sanity';
import { blocksSubgraphService } from '../blocks-subgraph/blocks-subgraph.service';
import { getOnChainBalances } from './src/onchainData';
import { providers } from 'ethers';
import { env } from '../../app/env';
import { BALANCER_NETWORK_CONFIG } from './src/contracts';
import { oneDayInMinutes, twentyFourHoursInMs } from '../util/time';
import moment from 'moment-timezone';
import {
    GqlBalancePoolAprItem,
    GqlBalancerGetPoolActivitiesInput,
    GqlBalancerPool,
    GqlBalancerPool24h,
    GqlBalancerPoolActivity,
    GqlBalancerPoolSnapshot,
} from '../../schema';
import _ from 'lodash';
import { Cache, CacheClass } from 'memory-cache';
import { cache } from '../cache/cache';
import { tokenPriceService } from '../token-price/token-price.service';
import { TokenPrices } from '../token-price/token-price-types';
import { beetsFarmService } from '../beets/beets-farm.service';
import { yearnVaultService } from '../boosted/yearn-vault.service';
import { BalancerBoostedPoolService } from '../pools/balancer-boosted-pool.service';
import { spookySwapService } from '../boosted/spooky-swap.service';

const POOLS_CACHE_KEY = 'pools:all';
const PAST_POOLS_CACHE_KEY = 'pools:24h';
const LATEST_PRICE_CACHE_KEY_PREFIX = 'pools:latestPrice:';
const POOL_SNAPSHOTS_CACHE_KEY_PREFIX = 'pools:snapshots:';
const TOP_TRADE_PAIRS_CACHE_KEY = 'balancer:topTradePairs';
const POOLS_24H_CACHE_KEY = 'pool:24hdata:';

const BOOSTED_POOLS = [
    '0x64b301e21d640f9bef90458b0987d81fb4cf1b9e00020000000000000000022e',
    '0x5ddb92a5340fd0ead3987d3661afcd6104c3b757000000000000000000000187',
    '0x56897add6dc6abccf0ada1eb83d936818bc6ca4d0002000000000000000002e8',
    '0x10441785a928040b456a179691141c48356eb3a50001000000000000000002fa',
];
const BB_YV_USD = '0x5ddb92a5340fd0ead3987d3661afcd6104c3b757000000000000000000000187';

export class BalancerService {
    cache: CacheClass<string, any>;

    constructor(private readonly boostedPoolService: BalancerBoostedPoolService) {
        this.cache = new Cache<string, any>();
    }

    public async getPool(id: string): Promise<GqlBalancerPool> {
        const pools = await this.getPools();
        const pool = pools.find((pool) => pool.id === id);

        if (!pool) {
            throw new Error('no pool found with id');
        }

        return pool;
    }

    public async getPools(): Promise<GqlBalancerPool[]> {
        const memCached = this.cache.get(POOLS_CACHE_KEY) as GqlBalancerPool[] | null;

        if (memCached) {
            return memCached;
        }

        const cached = await cache.getObjectValue<GqlBalancerPool[]>(POOLS_CACHE_KEY);

        if (cached) {
            this.cache.put(POOLS_CACHE_KEY, cached, 10000);

            return cached;
        }

        return this.cachePools();
    }

    public async getPastPools(): Promise<BalancerPoolFragment[]> {
        const memCached = this.cache.get(PAST_POOLS_CACHE_KEY) as BalancerPoolFragment[] | null;

        if (memCached) {
            return memCached;
        }

        const cached = await cache.getObjectValue<BalancerPoolFragment[]>(PAST_POOLS_CACHE_KEY);

        if (cached) {
            this.cache.put(PAST_POOLS_CACHE_KEY, cached, 10000);

            return cached;
        }

        return this.cachePastPools();
    }

    public async getLatestPrice(id: string): Promise<BalancerLatestPriceFragment | null> {
        const cached = this.cache.get(`${LATEST_PRICE_CACHE_KEY_PREFIX}${id}`) as BalancerLatestPriceFragment | null;

        if (cached) {
            return cached;
        }

        const latestPrice = await balancerSubgraphService.getLatestPrice(id);

        if (latestPrice) {
            this.cache.put(`${LATEST_PRICE_CACHE_KEY_PREFIX}${id}`, latestPrice);
        }

        return latestPrice;
    }

    public async cachePools(): Promise<GqlBalancerPool[]> {
        const provider = new providers.JsonRpcProvider(env.RPC_URL);
        const blacklistedPools = await this.getBlacklistedPools();

        const pools = await balancerSubgraphService.getAllPools({
            orderBy: Pool_OrderBy.TotalLiquidity,
            orderDirection: OrderDirection.Desc,
        });

        const filtered: GqlBalancerPool[] = pools
            //sort bb-yv-USD to the front
            .sort((pool1, pool2) => {
                if (pool1.id === BB_YV_USD) {
                    return -1;
                } else if (pool2.id === BB_YV_USD) {
                    return 1;
                }

                return 0;
            })
            .filter((pool) => {
                if (blacklistedPools.includes(pool.id)) {
                    return false;
                }

                /*if (parseFloat(pool.totalShares) < 0.001 && pool.poolType !== 'LiquidityBootstrapping') {
                    return false;
                }*/

                if (parseFloat(pool.totalShares) < 0.0001) {
                    return false;
                }

                return true;
            })
            .map((pool) => ({
                ...pool,
                symbol: pool.symbol || '',
                name:
                    pool.id === '0x5ddb92a5340fd0ead3987d3661afcd6104c3b757000000000000000000000187'
                        ? 'Steady Beets, Yearn Boosted'
                        : pool.name,
                __typename: 'GqlBalancerPool',
                tokens: (pool.tokens || []).map((token) => ({
                    ...token,
                    __typename: 'GqlBalancerPoolToken',
                    isBpt: token.address !== pool.address && !!pools.find((pool) => pool.address === token.address),
                    isPhantomBpt: token.address === pool.address,
                })),
                fees24h: '0',
                volume24h: '0',
                apr: {
                    total: '0',
                    hasRewardApr: false,
                    items: [],
                    swapApr: '0',
                    beetsApr: '0',
                    thirdPartyApr: '0',
                },
            }));

        const filteredWithOnChainBalances = await getOnChainBalances(
            filtered,
            BALANCER_NETWORK_CONFIG[`${env.CHAIN_ID}`].multicall,
            BALANCER_NETWORK_CONFIG[`${env.CHAIN_ID}`].vault,
            provider,
        );

        const pastPools = await this.getPastPools();
        const farms = await beetsFarmService.getBeetsFarms();
        const previousBlock = await blocksSubgraphService.getBlockFrom24HoursAgo();
        const blocksPerDay = await blocksSubgraphService.getBlocksPerDay();
        const blocksPerYear = blocksPerDay * 365;
        const { beetsPrice } = await tokenPriceService.getBeetsPrice();
        const tokenPrices = await tokenPriceService.getTokenPrices();
        await yearnVaultService.cacheYearnVaults();
        await spookySwapService.cacheSpookySwapData();

        const decoratedPools: GqlBalancerPool[] = [];

        for (const pool of filteredWithOnChainBalances) {
            const farm = farms.find((farm) => {
                if (pool.id === env.FBEETS_POOL_ID) {
                    return farm.id === env.FBEETS_FARM_ID;
                }

                return farm.pair.toLowerCase() === pool.address.toLowerCase();
            });
            const pastPool = pastPools.find((pastPool) => pastPool.id === pool.id);
            const totalLiquidity = this.calculatePoolLiquidity(pool, tokenPrices);
            const farmTvl =
                (Number(parseInt(farm?.slpBalance || '0') / 1e18) / parseFloat(pool.totalShares)) * totalLiquidity;
            let swapFee24h = parseFloat(pool.totalSwapFee) - parseFloat(pastPool?.totalSwapFee || '0');
            let volume24h = parseFloat(pool.totalSwapVolume) - parseFloat(pastPool?.totalSwapVolume || '0');

            if (pool.linearPools && pool.linearPools.length > 0) {
                const data = await this.boostedPoolService.calculatePoolData(
                    pool,
                    parseInt(previousBlock.timestamp),
                    moment().unix(),
                    filteredWithOnChainBalances,
                    tokenPrices,
                );

                swapFee24h = data.swapFees;
                volume24h = data.volume;
            }

            pool.totalLiquidity = `${totalLiquidity}`;
            const swapApr = totalLiquidity > 0 ? (swapFee24h / totalLiquidity) * 365 : 0;
            const {
                thirdPartyApr,
                beetsApr,
                items: farmAprItems,
            } = farm
                ? beetsFarmService.calculateFarmApr(farm, farmTvl, blocksPerYear, beetsPrice)
                : { items: [], thirdPartyApr: '0', beetsApr: '0' };
            const items: GqlBalancePoolAprItem[] = [
                { title: 'Swap fees APR', apr: `${swapApr}` },
                ...farmAprItems,
                ...this.getThirdPartyApr(pool, tokenPrices, decoratedPools.length === 0 ? pool : decoratedPools[0]),
            ];

            decoratedPools.push({
                ...pool,
                farm,
                apr: {
                    total: `${_.sumBy(items, (item) => parseFloat(item.apr))}`,
                    hasRewardApr: items.length > 1,
                    items,
                    swapApr: `${swapApr}`,
                    beetsApr,
                    thirdPartyApr,
                },
                isNewPool: moment().diff(moment.unix(pool.createTime), 'weeks') === 0,
                volume24h: `${volume24h}`,
                fees24h: `${swapFee24h}`,
                totalLiquidity: `${totalLiquidity}`,
            });
        }

        await cache.putObjectValue(POOLS_CACHE_KEY, decoratedPools);

        return decoratedPools;
    }

    public async cachePastPools(): Promise<BalancerPoolFragment[]> {
        const block = await blocksSubgraphService.getBlockFrom24HoursAgo();
        const blacklistedPools = await this.getBlacklistedPools();
        const pools = await balancerSubgraphService.getAllPools({
            orderBy: Pool_OrderBy.TotalLiquidity,
            orderDirection: OrderDirection.Desc,
            block: { number: parseInt(block.number) },
        });

        const filtered = pools.filter((pool) => {
            if (blacklistedPools.includes(pool.id)) {
                return false;
            }

            if (parseFloat(pool.totalShares) < 0.01) {
                return false;
            }

            return true;
        });

        await cache.putObjectValue(PAST_POOLS_CACHE_KEY, filtered);

        return filtered;
    }

    public async poolGet24hData(poolId: string): Promise<GqlBalancerPool24h> {
        const cached = await cache.getObjectValue<GqlBalancerPool24h>(`${POOLS_24H_CACHE_KEY}${poolId}`);

        if (cached) {
            return cached;
        }

        const previousBlock = await blocksSubgraphService.getBlockFrom24HoursAgo();
        const pools = await this.getPools();
        const pool = pools.find((pool) => pool.id === poolId);
        const { pool: previousPool } = await balancerSubgraphService.getPool({
            id: poolId,
            block: { number: parseInt(previousBlock.number) },
        });

        if (!pool || !previousPool) {
            throw new Error('could not find pool');
        }

        const data: GqlBalancerPool24h = {
            ...pool,
            __typename: 'GqlBalancerPool24h',
            liquidityChange24h: `${parseFloat(pool.totalLiquidity) - parseFloat(previousPool.totalLiquidity)}`,
            swapVolume24h: `${parseFloat(pool.totalSwapVolume) - parseFloat(previousPool.totalSwapVolume)}`,
            swapFees24h: `${parseFloat(pool.totalSwapFee) - parseFloat(previousPool.totalSwapFee)}`,
        };

        await cache.putObjectValue(`${POOLS_24H_CACHE_KEY}${poolId}`, data, 5);

        return data;
    }

    public async getPoolSnapshots(poolId: string): Promise<GqlBalancerPoolSnapshot[]> {
        const snapshots: GqlBalancerPoolSnapshot[] = [];
        const blocks = await blocksSubgraphService.getDailyBlocks(60);
        const historicalTokenPrices = await tokenPriceService.getHistoricalTokenPrices();

        const cached = this.cache.get(`${POOL_SNAPSHOTS_CACHE_KEY_PREFIX}:${poolId}:${blocks[0].number}`) as
            | GqlBalancerPoolSnapshot[]
            | null;

        if (cached) {
            return cached;
        }

        for (let i = 0; i < blocks.length - 1; i++) {
            const block = blocks[i];

            const previousBlock = blocks[i + 1];
            const blockNumber = parseInt(block.number);
            const pools = await balancerSubgraphService.getAllPoolsAtBlock(blockNumber);
            const previousPools = await balancerSubgraphService.getAllPoolsAtBlock(parseInt(previousBlock.number));
            const tokenPrices = tokenPriceService.getTokenPricesForTimestamp(
                parseInt(block.timestamp),
                historicalTokenPrices,
            );

            const pool = pools.find((pool) => pool.id === poolId);
            const previousPool = previousPools.find((previousPool) => previousPool.id === poolId);

            if (!pool || !previousPool) {
                break;
            }

            let swapFees24h = parseFloat(pool.totalSwapFee) - parseFloat(previousPool.totalSwapFee);
            let swapVolume24h = parseFloat(pool.totalSwapVolume) - parseFloat(previousPool.totalSwapVolume);

            if (this.boostedPoolService.hasNestedBpt(pool, pools)) {
                pool.totalLiquidity = `${this.boostedPoolService.calculatePoolLiquidity(pool, tokenPrices)}`;

                const data = await this.boostedPoolService.calculatePoolData(
                    pool,
                    parseInt(previousBlock.timestamp),
                    parseInt(block.timestamp),
                    pools,
                    tokenPrices,
                );

                swapVolume24h = data.volume;
                swapFees24h = data.swapFees;
            }

            if (
                Math.abs(swapFees24h) > 500_000_000 ||
                swapVolume24h > Math.abs(500_000_000) ||
                swapFees24h < 0 ||
                swapVolume24h < 0
            ) {
                continue;
            }

            snapshots.push({
                id: `${poolId}-${block.timestamp}`,
                poolId,
                timestamp: parseInt(block.timestamp),
                totalShares: pool.totalShares,
                totalSwapFee: pool.totalSwapFee,
                totalSwapVolume: pool.totalSwapVolume,
                totalLiquidity: pool.totalLiquidity,
                swapFees24h: `${swapFees24h}`,
                swapVolume24h: `${swapVolume24h}`,
                liquidityChange24h: `${parseFloat(pool.totalLiquidity) - parseFloat(previousPool.totalLiquidity)}`,
                tokens: (pool.tokens || []).map((token) => ({
                    ...token,
                    __typename: 'GqlBalancerPoolToken',
                })),
            });
        }

        const orderedSnapshots = _.orderBy(snapshots, 'timestamp', 'asc');

        this.cache.put(
            `${POOL_SNAPSHOTS_CACHE_KEY_PREFIX}:${poolId}:${blocks[0].number}`,
            orderedSnapshots,
            twentyFourHoursInMs,
        );

        return orderedSnapshots;
    }

    public async getTopTradingPairs(): Promise<BalancerTradePairSnapshotFragment[]> {
        const cached = await cache.getObjectValue<BalancerTradePairSnapshotFragment[]>(TOP_TRADE_PAIRS_CACHE_KEY);

        if (cached) {
            return cached;
        }

        return this.cacheTopTradingPairs();
    }

    public async cacheTopTradingPairs(): Promise<BalancerTradePairSnapshotFragment[]> {
        const timestamp = moment().utc().startOf('day').unix();

        const { tradePairSnapshots } = await balancerSubgraphService.getTradePairSnapshots({
            first: 5,
            orderBy: TradePairSnapshot_OrderBy.TotalSwapVolume,
            orderDirection: OrderDirection.Desc,
            where: { timestamp_gt: timestamp },
        });

        await cache.putObjectValue(TOP_TRADE_PAIRS_CACHE_KEY, tradePairSnapshots, oneDayInMinutes);

        return tradePairSnapshots;
    }

    public async getPoolActivities({
        poolId,
        first,
        skip,
        sender,
    }: GqlBalancerGetPoolActivitiesInput): Promise<GqlBalancerPoolActivity[]> {
        const pool = await this.getPool(poolId);
        const tokenPrices = await tokenPriceService.getTokenPrices();

        const { joinExits } = await balancerSubgraphService.getPoolJoinExits({
            where: { pool: poolId, sender: sender?.toLowerCase() },
            first,
            skip,
            orderBy: JoinExit_OrderBy.Timestamp,
            orderDirection: OrderDirection.Desc,
        });

        return joinExits.map((activity) => {
            const valueUSD =
                activity.valueUSD === '0' || BOOSTED_POOLS.includes(poolId)
                    ? _.sum(
                          activity.amounts.map((amount, index) => {
                              return (
                                  tokenPriceService.getPriceForToken(tokenPrices, pool.tokensList[index]) *
                                  parseFloat(amount)
                              );
                          }),
                      )
                    : activity.valueUSD;

            return {
                ...activity,
                __typename: 'GqlBalancerPoolActivity',
                poolId: activity.pool.id,
                valueUSD: `${valueUSD}`,
            };
        });
    }

    public async getLateQuartetBptPrice(): Promise<number> {
        const pools = await this.getPools();
        const lateQuartet = pools.find(
            (pool) => pool.id === '0xf3a602d30dcb723a74a0198313a7551feaca7dac00010000000000000000005f',
        );

        if (!lateQuartet) {
            throw new Error('pool not found');
        }

        return parseFloat(lateQuartet.totalLiquidity) / parseFloat(lateQuartet.totalShares);
    }

    private async getBlacklistedPools() {
        const response = await sanityClient.fetch<string[] | null>(
            `*[_type == "config" && chainId == ${env.CHAIN_ID}][0].blacklistedPools`,
        );

        return response || [];
    }

    private calculatePoolLiquidity(pool: GqlBalancerPool, tokenPrices: TokenPrices) {
        if (pool.poolType === 'Linear') {
            return 0;
        }

        const tokens = pool.tokens || [];

        return _.sumBy(tokens, (token) => {
            if (token.address === pool.address) {
                return 0;
            }

            const tokenPrice = tokenPriceService.getPriceForToken(tokenPrices, token.address);
            const balance = parseFloat(token.balance) > 0 ? parseFloat(token.balance) : 0;

            return tokenPrice * balance;
        });
    }

    private getThirdPartyApr(
        pool: GqlBalancerPool,
        tokenPrices: TokenPrices,
        bbyvUsd: GqlBalancerPool,
    ): GqlBalancePoolAprItem[] {
        let items: GqlBalancePoolAprItem[] = [];

        if (pool.linearPools && pool.linearPools.length > 0) {
            const yearnAprItem = yearnVaultService.getAprItemForBoostedPool(pool, tokenPrices, bbyvUsd);

            if (yearnAprItem) {
                items.push(yearnAprItem);
            }

            const spookyAprItem = spookySwapService.getAprItemForBoostedPool(pool, tokenPrices);

            if (spookyAprItem) {
                items.push(spookyAprItem);
            }
        }

        return items;
    }
}

export const balancerService = new BalancerService(new BalancerBoostedPoolService());
