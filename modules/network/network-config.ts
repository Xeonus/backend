import { fantomNetworkConfig } from './fantom';
import { optimismNetworkConfig } from './optimism';
import { NetworkConfig } from './network-config-types';
import { mainnetNetworkConfig } from './mainnet';
import { arbitrumNetworkConfig } from './arbitrum';
import { polygonNetworkConfig } from './polygon';
import { gnosisNetworkConfig } from './gnosis';
import { zkevmNetworkConfig } from './zkevm';

export const AllNetworkConfigs: { [chainId: string]: NetworkConfig } = {
    '250': fantomNetworkConfig,
    '10': optimismNetworkConfig,
    '1': mainnetNetworkConfig,
    '42161': arbitrumNetworkConfig,
    '137': polygonNetworkConfig,
    '100': gnosisNetworkConfig,
    '1101': zkevmNetworkConfig
};

export const BalancerChainIds = ['1', '137', '42161', '100', '1101'];
export const BeethovenChainIds = ['250', '10'];
