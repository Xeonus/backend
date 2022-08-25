import { Resolvers } from '../../schema';
import { balancerSorService } from './balancer-sor.service';
import { tokenService } from '../token/token.service';

const balancerSorResolvers: Resolvers = {
    Query: {
        sorGetSwaps: async (parent, args) => {
            const tokens = await tokenService.getTokens();

            return balancerSorService.getSwaps({ ...args, tokens });
        },
        sorGetBatchSwapForTokensIn: async (parent, args) => {
            const tokens = await tokenService.getTokens();

            return balancerSorService.getBatchSwapForTokensIn({ ...args, tokens });
        },
    },
};

export default balancerSorResolvers;
