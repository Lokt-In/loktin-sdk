import { describe, expect, it } from 'vitest';
import deployments from '../../../deployments/testnet.json' with { type: 'json' };
import { InvalidInputError, TESTNET, createLoktin } from '../src/index.js';
import { USER } from './fake-server.js';

const LOCAL = {
  passphrase: 'Standalone Network ; February 2017',
  rpcUrl: 'http://localhost:8000/rpc',
  contracts: {
    targetSavings: TESTNET.contracts.spendSave,
    spendSave: TESTNET.contracts.targetSavings,
  },
  token: TESTNET.token,
};

describe('testnet settings', () => {
  it('match deployments/testnet.json', () => {
    expect(TESTNET.passphrase).toBe(deployments.network_passphrase);
    expect(TESTNET.contracts.targetSavings).toBe(
      deployments.contracts.target_savings.id,
    );
    expect(TESTNET.contracts.spendSave).toBe(
      deployments.contracts.spend_save.id,
    );
    expect(TESTNET.token).toBe(deployments.usdc);
  });

  it('are used for "testnet"', () => {
    const { config } = createLoktin({ network: 'testnet' });
    expect(config).toMatchObject({
      passphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      allowHttp: false,
      contracts: TESTNET.contracts,
      token: TESTNET.token,
    });
  });

  it('take rpcUrl and contract overrides', () => {
    const { config } = createLoktin({
      network: 'testnet',
      rpcUrl: 'https://rpc.example.com',
      contracts: { spendSave: TESTNET.contracts.targetSavings },
    });
    expect(config.rpcUrl).toBe('https://rpc.example.com');
    expect(config.contracts).toEqual({
      targetSavings: TESTNET.contracts.targetSavings,
      spendSave: TESTNET.contracts.targetSavings,
    });
  });
});

describe('own deployments', () => {
  it('are accepted, with http on localhost', () => {
    const { config } = createLoktin({ network: LOCAL });
    expect(config).toMatchObject({
      passphrase: LOCAL.passphrase,
      allowHttp: true,
      contracts: LOCAL.contracts,
    });
    expect(
      createLoktin({
        network: { ...LOCAL, rpcUrl: 'http://127.0.0.1:8000/rpc' },
      }).config.allowHttp,
    ).toBe(true);
  });

  it('refuse the public network passphrase', () => {
    const network = {
      ...LOCAL,
      passphrase: 'Public Global Stellar Network ; September 2015',
    };
    expect(() => createLoktin({ network })).toThrow(
      /public network is not supported/,
    );
    expect(() => createLoktin({ network })).toThrow(InvalidInputError);
  });

  it('refuse http on any other host', () => {
    for (const rpcUrl of [
      'http://rpc.example.com',
      'http://192.168.1.2:8000',
      'http://localhost.example.com',
    ]) {
      expect(() => createLoktin({ network: { ...LOCAL, rpcUrl } })).toThrow(
        /https, or http on localhost/,
      );
    }
  });

  it('refuse a URL that does not parse, or another protocol', () => {
    expect(() =>
      createLoktin({ network: { ...LOCAL, rpcUrl: 'not a url' } }),
    ).toThrow(/must be a URL/);
    expect(() =>
      createLoktin({ network: { ...LOCAL, rpcUrl: 'ftp://localhost' } }),
    ).toThrow(InvalidInputError);
  });

  it('refuse invalid contract and token ids', () => {
    expect(() => createLoktin({ network: { ...LOCAL, token: USER } })).toThrow(
      /network.token/,
    );
    expect(() =>
      createLoktin({
        network: {
          ...LOCAL,
          contracts: { ...LOCAL.contracts, targetSavings: 'C123' },
        },
      }),
    ).toThrow(/contracts.targetSavings/);
    expect(() =>
      createLoktin({ network: 'testnet', contracts: { spendSave: USER } }),
    ).toThrow(/contracts.spendSave/);
  });
});

describe('accounts and signers', () => {
  it('accept an account address as publicKey', () => {
    expect(
      createLoktin({ network: 'testnet', publicKey: USER }).config.publicKey,
    ).toBe(USER);
  });

  it('refuse a publicKey that is not an account address', () => {
    expect(() =>
      createLoktin({ network: 'testnet', publicKey: TESTNET.token }),
    ).toThrow(/publicKey/);
    expect(() =>
      createLoktin({ network: 'testnet', publicKey: 'G123' }),
    ).toThrow(InvalidInputError);
  });

  it('refuse a signer without signTransaction', () => {
    const signer = {} as unknown as { signTransaction: never };
    expect(() => createLoktin({ network: 'testnet', signer })).toThrow(
      /signTransaction/,
    );
  });
});
