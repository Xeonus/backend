import { isSameAddress } from '@balancer-labs/sdk';
import { formatFixed } from '@ethersproject/bignumber';
import { AddressZero } from '@ethersproject/constants';
import { ethers } from 'ethers';
import _ from 'lodash';
import { prisma } from '../../../prisma/prisma-client';
import { prismaBulkExecuteOperations } from '../../../prisma/prisma-util';
import { BalancerUserPoolShare } from '../../subgraphs/balancer-subgraph/balancer-subgraph-types';
import { BeetsBarSubgraphService } from '../../subgraphs/beets-bar-subgraph/beets-bar.service';
import { BeetsBarUserFragment } from '../../subgraphs/beets-bar-subgraph/generated/beets-bar-subgraph-types';
import { Multicaller, MulticallUserBalance } from '../../web3/multicaller';
import ERC20Abi from '../../web3/abi/ERC20.json';
import { networkContext } from '../../network/network-context.service';
import { AllNetworkConfigs } from '../../network/network-config';

export class UserSyncWalletBalanceService {
    beetsBarService?: BeetsBarSubgraphService;

    constructor(private _chainId?: number) {
        if (this.isFantomNetwork) {
            this.beetsBarService = new BeetsBarSubgraphService(
                AllNetworkConfigs['250'].data.subgraphs.beetsBar!,
                this.fbeetsAddress,
            );
        }
    }

    get isFantomNetwork() {
        return String(this.chain) === 'FANTOM';
    }

    get balancerSubgraphService() {
        return AllNetworkConfigs[this.chainId].services.balancerSubgraphService;
    }

    get chainId() {
        return String(this._chainId || networkContext.chainId);
    }

    get chain() {
        return AllNetworkConfigs[this.chainId].data.chain.prismaId;
    }

    get vaultAddress() {
        return AllNetworkConfigs[this.chainId].data.balancer.vault;
    }

    get fbeetsAddress() {
        return AllNetworkConfigs['250'].data.fbeets!.address;
    }

    get provider() {
        return AllNetworkConfigs[this.chainId].provider;
    }

    get multicallAddress() {
        return AllNetworkConfigs[this.chainId].data.multicall;
    }

    get rpcMaxBlockRange() {
        return AllNetworkConfigs[this.chainId].data.rpcMaxBlockRange;
    }

    public async initBalancesForPools() {
        console.log('initBalancesForPools: loading balances, pools, block...');
        const { block } = await this.balancerSubgraphService.getMetadata();

        let endBlock = block.number;
        console.log(`Loading balances at block ${endBlock}`);

        if (this.beetsBarService) {
            const { block: beetsBarBlock } = await this.beetsBarService.getMetadata();
            endBlock = Math.min(endBlock, beetsBarBlock.number);
        }

        const pools = await prisma.prismaPool.findMany({
            select: { id: true, address: true },
            where: { dynamicData: { totalSharesNum: { gt: 0.000000000001 } }, chain: this.chain },
        });
        const poolIdsToInit = pools.map((pool) => pool.id);
        const shares = await this.balancerSubgraphService.getAllPoolSharesWithBalance(poolIdsToInit, [
            AddressZero,
            this.vaultAddress,
        ]);

        console.log(`Found ${poolIdsToInit.length} pools to init`);
        console.log(`Found ${shares.length} shares to sync`);

        let fbeetsHolders: BeetsBarUserFragment[] = [];

        if (this.beetsBarService) {
            fbeetsHolders = await this.beetsBarService.getAllUsers({ where: { fBeets_not: '0' } });
        }

        let operations: any[] = [];
        operations.push(prisma.prismaUserWalletBalance.deleteMany({ where: { chain: this.chain } }));

        for (const pool of pools) {
            const poolShares = shares.filter((share) => share.poolAddress.toLowerCase() === pool.address);

            if (poolShares.length > 0) {
                operations = [
                    ...operations,
                    ...poolShares.map((share) => this.getPrismaUpsertForPoolShare(pool.id, share)),
                ];
            }
        }

        console.log(`initBalancesForPools: performing ${operations.length} db operations...`);
        await prismaBulkExecuteOperations(
            [
                prisma.prismaUser.createMany({
                    data: _.uniq([
                        ...shares.map((share) => share.userAddress),
                        ...fbeetsHolders.map((user) => user.address),
                    ]).map((address) => ({ address })),
                    skipDuplicates: true,
                }),
                ...operations,
                ...fbeetsHolders.map((user) => this.getUserWalletBalanceUpsertForFbeets(user.address, user.fBeets)),
                prisma.prismaUserBalanceSyncStatus.upsert({
                    where: { type_chain: { type: 'WALLET', chain: this.chain } },
                    create: { type: 'WALLET', blockNumber: endBlock, chain: this.chain },
                    update: { blockNumber: Math.min(block.number, endBlock) },
                }),
            ],
            true,
        );
        console.log('initBalancesForPools: finished performing db operations...');
    }

    public async syncChangedBalancesForAllPools() {
        const erc20Interface = new ethers.utils.Interface(ERC20Abi);
        const latestBlock = await this.provider.getBlockNumber();
        const syncStatus = await prisma.prismaUserBalanceSyncStatus.findUnique({
            where: { type_chain: { type: 'WALLET', chain: this.chain } },
        });
        const response = await prisma.prismaPool.findMany({
            select: { id: true, address: true },
            where: { chain: this.chain },
        });

        const poolAddresses = response.map((item) => item.address);

        if (this.isFantomNetwork) {
            poolAddresses.push(this.fbeetsAddress);
        }

        if (!syncStatus) {
            throw new Error('UserWalletBalanceService: syncBalances called before initBalances');
        }

        const fromBlock = syncStatus.blockNumber + 1;

        // no new blocks have been minted, needed for slow networks
        if (fromBlock > latestBlock) {
            return;
        }

        // Split the range into smaller chunks to avoid RPC limits, setting up to 50 times max block range
        const toBlock = Math.min(fromBlock + 50 * this.rpcMaxBlockRange, latestBlock);
        const range = toBlock - fromBlock;
        console.log(`UserWalletBalanceService: syncing balances from ${fromBlock} to ${toBlock}`);
        console.log(`user-sync-wallet-balances-for-all-pools-${this.chainId} getLogs of ${poolAddresses.length} pools`);
        const events = await Promise.all(
            // Getting logs in batches of max blocks allowed by RPC
            Array.from({ length: Math.ceil(range / this.rpcMaxBlockRange) }, (_, i) => i).map(async (i) => {
                const from = fromBlock + i * this.rpcMaxBlockRange;
                const to = Math.min(fromBlock + (i + 1) * this.rpcMaxBlockRange, toBlock);

                // Usually RPCs are handling any number of addresses, but it here batching just to be on the safe side
                const logRequests: Promise<ethers.providers.Log[]>[] = _.chunk(poolAddresses, 500).map((addresses) => {
                    // Fetch logs with a raw json request until we support Viem or Ethers6
                    const payload = {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'eth_getLogs',
                        params: [
                            {
                                address: addresses,
                                topics: [ethers.utils.id('Transfer(address,address,uint256)')],
                                fromBlock: '0x' + BigInt(from).toString(16),
                                toBlock: '0x' + BigInt(to).toString(16),
                            },
                        ],
                    };

                    return fetch(AllNetworkConfigs[this.chainId].data.rpcUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload),
                    })
                        .then((response) => response.json() as Promise<{ result: ethers.providers.Log[] }>)
                        .then(({ result }) => result)
                        .catch((error) => {
                            console.error('Error fetching logs:', error);
                            return [];
                        });

                    // Fetching logs with Viem
                    // viemClient.getLogs({
                    //     address: addresses,
                    //     event: parseAbiItem('event Transfer(address indexed, address indexed, uint256)'),
                    //     fromBlock: BigInt(from),
                    //     toBlock: BigInt(to),
                    // })
                });

                const events = await Promise.all(logRequests).then((res) => res.flat());

                return events;
            }),
        ).then((res) => res.flat());

        console.log(
            `user-sync-wallet-balances-for-all-pools-${this.chainId} getLogs of ${poolAddresses.length} pools done`,
        );

        const relevantERC20Addresses = poolAddresses;

        if (this.isFantomNetwork) {
            relevantERC20Addresses.push(this.fbeetsAddress);
        }

        const balancesToFetch = _.uniqBy(
            events
                .filter((event) =>
                    //we also need to track fbeets balance
                    relevantERC20Addresses.includes(event.address.toLowerCase()),
                )
                .map((event) => {
                    const parsed = erc20Interface.parseLog(event);

                    return [
                        { erc20Address: event.address, userAddress: parsed.args?.from as string },
                        { erc20Address: event.address, userAddress: parsed.args?.to as string },
                    ];
                })
                .flat(),
            (entry) => entry.erc20Address + entry.userAddress,
        );

        console.log(
            `user-sync-wallet-balances-for-all-pools-${this.chainId} got ${balancesToFetch.length} balances to fetch.`,
        );

        if (balancesToFetch.length === 0) {
            await prisma.prismaUserBalanceSyncStatus.upsert({
                where: { type_chain: { type: 'WALLET', chain: this.chain } },
                create: { type: 'WALLET', chain: this.chain, blockNumber: toBlock },
                update: { blockNumber: toBlock },
            });

            return;
        }

        const balances = await Multicaller.fetchBalances({
            multicallAddress: this.multicallAddress,
            provider: this.provider,
            balancesToFetch,
        });

        await prismaBulkExecuteOperations(
            [
                //make sure all users exist
                prisma.prismaUser.createMany({
                    data: balances.map((item) => ({ address: item.userAddress })),
                    skipDuplicates: true,
                }),
                //update balances
                ...balances
                    .filter(({ userAddress }) => userAddress !== AddressZero)
                    .map((userBalance) => {
                        if (this.isFantomNetwork && isSameAddress(userBalance.erc20Address, this.fbeetsAddress)) {
                            return this.getUserWalletBalanceUpsertForFbeets(
                                userBalance.userAddress,
                                formatFixed(userBalance.balance, 18),
                            );
                        }
                        const poolId = response.find((item) => item.address === userBalance.erc20Address)?.id;
                        return this.getUserWalletBalanceUpsert(userBalance, poolId!);
                    }),
                prisma.prismaUserBalanceSyncStatus.upsert({
                    where: { type_chain: { type: 'WALLET', chain: this.chain } },
                    create: { type: 'WALLET', chain: this.chain, blockNumber: toBlock },
                    update: { blockNumber: toBlock },
                }),
            ],
            true,
        );
    }

    public async initBalancesForPool(poolId: string) {
        const { block } = await this.balancerSubgraphService.getMetadata();

        const shares = await this.balancerSubgraphService.getAllPoolSharesWithBalance([poolId], [AddressZero]);

        await prismaBulkExecuteOperations(
            [
                prisma.prismaUser.createMany({
                    data: shares.map((share) => ({ address: share.userAddress })),
                    skipDuplicates: true,
                }),
                ...shares.map((share) => this.getPrismaUpsertForPoolShare(poolId, share)),
                prisma.prismaUserBalanceSyncStatus.upsert({
                    where: { type_chain: { type: 'WALLET', chain: this.chain } },
                    create: { type: 'WALLET', chain: this.chain, blockNumber: block.number },
                    update: { blockNumber: block.number },
                }),
            ],
            true,
        );
    }

    public async syncUserBalance(userAddress: string, poolId: string, poolAddresses: string) {
        const balancesToFetch = [{ erc20Address: poolAddresses, userAddress }];

        if (this.isFantomNetwork && isSameAddress(this.fbeetsAddress, poolAddresses)) {
            balancesToFetch.push({ erc20Address: this.fbeetsAddress, userAddress });
        }

        const balances = await Multicaller.fetchBalances({
            multicallAddress: this.multicallAddress,
            provider: this.provider,
            balancesToFetch,
        });

        const operations = balances.map((userBalance) => this.getUserWalletBalanceUpsert(userBalance, poolId));

        await Promise.all(operations);
    }

    private getPrismaUpsertForPoolShare(poolId: string, share: BalancerUserPoolShare) {
        return prisma.prismaUserWalletBalance.upsert({
            where: { id_chain: { id: `${poolId}-${share.userAddress}`, chain: this.chain } },
            create: {
                id: `${poolId}-${share.userAddress}`,
                chain: this.chain,
                userAddress: share.userAddress,
                poolId,
                tokenAddress: share.poolAddress.toLowerCase(),
                balance: share.balance,
                balanceNum: parseFloat(share.balance),
            },
            update: { balance: share.balance, balanceNum: parseFloat(share.balance) },
        });
    }

    private getUserWalletBalanceUpsertForFbeets(userAddress: string, balance: string) {
        return prisma.prismaUserWalletBalance.upsert({
            where: { id_chain: { id: `fbeets-${userAddress}`, chain: this.chain } },
            create: {
                id: `fbeets-${userAddress}`,
                chain: this.chain,
                userAddress: userAddress,
                tokenAddress: this.fbeetsAddress,
                balance,
                balanceNum: parseFloat(balance),
            },
            update: { balance: balance, balanceNum: parseFloat(balance) },
        });
    }

    private getUserWalletBalanceUpsert(userBalance: MulticallUserBalance, poolId: string) {
        const { userAddress, balance, erc20Address } = userBalance;

        return prisma.prismaUserWalletBalance.upsert({
            where: { id_chain: { id: `${poolId}-${userAddress}`, chain: this.chain } },
            create: {
                id: `${poolId}-${userAddress}`,
                chain: this.chain,
                userAddress,
                poolId,
                tokenAddress: erc20Address,
                balance: formatFixed(balance, 18),
                balanceNum: parseFloat(formatFixed(balance, 18)),
            },
            update: {
                balance: formatFixed(balance, 18),
                balanceNum: parseFloat(formatFixed(balance, 18)),
            },
        });
    }
}
