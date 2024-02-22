import config from '../../config';
import { addMissingPoolsFromSubgraph } from '../actions/pool/add-pools-from-subgraph';
import { updateOnChainDataForPools } from '../actions/pool/update-on-chain-data';
import { chainIdToChain } from '../network/chain-id-to-chain';
import { getViemClient } from '../sources/viem-client';
import { getPoolsSubgraphClient } from '../subgraphs/balancer-v3-pools';
import { getVaultSubgraphClient } from '../subgraphs/balancer-v3-vault';

/**
 * Controller responsible for matching job requests to configured job handlers
 *
 * @param name - the name of the job
 * @param chain - the chain to run the job on
 * @returns a controller with configured job handlers
 */
export function JobsController(tracer?: any) {
    // Setup tracing
    // ...
    return {
        async addMissingPoolsFromSubgraph(chainId: string) {
            const chain = chainIdToChain[chainId];
            const {
                subgraphs: { balancerV3, balancerPoolsV3 },
                balancer: {
                    v3: { vaultAddress },
                },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3);
            const poolSubgraphClient = getPoolsSubgraphClient(balancerPoolsV3!);
            const viemClient = getViemClient(chain);

            // TODO: add syncing v2 pools as well by splitting the poolService into separate
            // actions with extracted configuration

            const added = await addMissingPoolsFromSubgraph(vaultSubgraphClient, poolSubgraphClient, chain);

            //required steps:
            // update onchain data and status
            const updated = updateOnChainDataForPools(vaultAddress, '123', added, viemClient);
            // sync swaps
            // updateVolumeAndFeeValues
        },
    };
}
