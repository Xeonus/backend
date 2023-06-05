import * as _ from 'lodash';
import { prisma } from '../../../prisma/prisma-client';
import { PrismaLastBlockSyncedCategory } from '@prisma/client';
import { poolService } from '../pool.service';
import { getContractAt } from '../../web3/contract';
import VaultAbi from '../abi/Vault.json';
import { networkContext } from '../../network/network-context.service';

export class PoolSyncService {
    public async syncChangedPools() {
        let lastSync = await prisma.prismaLastBlockSynced.findUnique({
            where: { category_chain: { category: PrismaLastBlockSyncedCategory.POOLS, chain: networkContext.chain } },
        });
        const lastSyncBlock = lastSync?.blockNumber ?? 0;
        const latestBlock = await networkContext.provider.getBlockNumber();

        // const startBlock = lastSyncBlock + 1;
        // const endBlock =
        //     latestBlock - startBlock > networkContext.data.rpcMaxBlockRange
        //         ? startBlock + networkContext.data.rpcMaxBlockRange
        //         : latestBlock;

        const startBlock = 552170;
        const endBlock = 552190;
        console.log("Start block: ", startBlock, " end block: ", endBlock);

        // no new blocks have been minted, needed for slow networks
        if (startBlock > endBlock) {
            return;
        }


        const contract = getContractAt(networkContext.data.balancer.vault, VaultAbi);

        const events = await contract.queryFilter(
            { address: networkContext.data.balancer.vault },
            startBlock,
            endBlock,
        );
        console.log("Events: ", events);
        const filteredEvents = events.filter((event) =>
            ['PoolBalanceChanged', 'PoolBalanceManaged', 'Swap'].includes(event.event!),
        );
        const poolIds: string[] = _.uniq(filteredEvents.map((event) => event.args!.poolId));
        if (poolIds.length !== 0) {
            console.log(`Syncing ${poolIds.length} pools`);
            await poolService.updateOnChainDataForPools(poolIds, endBlock);

            console.log('Syncing swaps');

            const poolsWithNewSwaps = await poolService.syncSwapsForLast48Hours();

            console.log("Updating volume and fee values")
            await poolService.updateVolumeAndFeeValuesForPools(poolsWithNewSwaps);
        }

        await prisma.prismaLastBlockSynced.upsert({
            where: { category_chain: { category: PrismaLastBlockSyncedCategory.POOLS, chain: networkContext.chain } },
            update: {
                blockNumber: endBlock,
            },
            create: {
                category: PrismaLastBlockSyncedCategory.POOLS,
                blockNumber: endBlock,
                chain: networkContext.chain,
            },
        });
    }

    public async setPoolsWithPreferredGaugesAsIncentivized() {
        const poolsWithGauges = await prisma.prismaPool.findMany({
            include: { staking: true },
            where: {
                staking: {
                    some: {
                        gauge: { status: 'PREFERRED' },
                    },
                },
            },
        });

        await prisma.prismaPoolCategory.createMany({
            data: poolsWithGauges.map((pool) => ({
                id: `${networkContext.chain}-${pool.id}-INCENTIVIZED`,
                poolId: pool.id,
                category: 'INCENTIVIZED' as const,
                chain: networkContext.chain,
            })),
            skipDuplicates: true,
        });

        await prisma.prismaPoolCategory.deleteMany({
            where: {
                category: 'INCENTIVIZED',
                chain: networkContext.chain,
                poolId: {
                    notIn: poolsWithGauges.map((pool) => pool.id),
                },
            },
        });
    }
}
