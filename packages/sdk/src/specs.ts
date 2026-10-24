import { Spec } from '@stellar/stellar-sdk/contract';
import { spendSaveSpec } from './generated/spend-save-spec.js';
import { targetSavingsSpec } from './generated/target-savings-spec.js';

/** The Loktin contracts the SDK calls. */
export type LoktinContract = 'target-savings' | 'spend-save';

/** Contract specs, extracted from the built Wasm (K4). */
export const specs: Readonly<Record<LoktinContract, Spec>> = {
  'target-savings': new Spec([...targetSavingsSpec]),
  'spend-save': new Spec([...spendSaveSpec]),
};
