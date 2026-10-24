import { Networks } from '@stellar/stellar-sdk/base';

/** Contract ids of one Loktin deployment. */
export interface ContractIds {
  readonly targetSavings: string;
  readonly spendSave: string;
}

/** Everything the SDK needs to know about a network and its deployment. */
export interface NetworkSettings {
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly contracts: ContractIds;
  /** The token both contracts hold, such as USDC. */
  readonly token: string;
}

/**
 * Loktin's testnet deployment. The ids are copied from
 * deployments/testnet.json, and a test fails if they differ.
 */
export const TESTNET: NetworkSettings = {
  passphrase: Networks.TESTNET,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contracts: {
    targetSavings: 'CCJH2IRI7JVZ7JV7J4XLUPVIPVMLG2HB7OBDQC2F3XLPVOVBH3QQVP4Z',
    spendSave: 'CCUFRRPCCE7YVKTG3FWE2RAW5ACMU7KVACTVKDM452C5QFMABAXQTTCN',
  },
  // Circle testnet USDC.
  token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
};

/** The public network's passphrase. There is no mainnet in this version. */
export const PUBLIC_PASSPHRASE: string = Networks.PUBLIC;
