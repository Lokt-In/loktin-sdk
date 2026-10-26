import { StrKey } from '@stellar/stellar-sdk/base';
import type { IntegratorOptions } from '../config.js';
import { InvalidInputError } from '../errors.js';
import type { Loktin, WriteResult } from '../loktin.js';
import type { TimeWindow } from '../time.js';
import {
  checkAddress,
  checkIntegrator,
  checkPositive,
  checkU64,
  userOf,
  writerOf,
} from '../validate.js';
import {
  type Destination,
  type Enrollment,
  type RawEnrollment,
  type RawSaving,
  type RawSkimPreview,
  type RawWithdrawal,
  type Saving,
  type SkimPreview,
  type SkimSettings,
  type SpendSaveReadAdapter,
  type SpendSaveWithdrawal,
  effectiveWithdrawalDay,
  toEnrollment,
  toRawDestination,
  toSaving,
  toSkimPreview,
  toWindow,
  toWithdrawal,
} from './types.js';

/** Lowest skim percentage, 1% (P12). */
const MIN_PERCENT_BPS = 100;
/** Highest skim percentage, 50% (P12). */
const MAX_PERCENT_BPS = 5_000;
/** Withdrawal days run from 1 to 28 (P16). */
const MIN_DAY = 1;
const MAX_DAY = 28;

/** The settings of {@link SpendSave.enroll} and {@link SpendSave.updateSettings}. */
export interface EnrollInput {
  readonly skim: SkimSettings;
  /** The most saved in one UTC month, in base units. None when undefined. */
  readonly monthlyCap?: bigint | undefined;
  readonly destination: Destination;
  /** The day of the month, 1 to 28, when the balance can be withdrawn (UTC). */
  readonly withdrawalDay: number;
}

/** An enrolment, with the withdrawal day that applies now. */
export interface EnrollmentView extends Enrollment {
  /**
   * The withdrawal day that applies now, with any pending change that has
   * taken effect. For display only: it uses the device clock in UTC, and at
   * the edge of a month the chain decides.
   */
  readonly effectiveWithdrawalDay: number;
}

// Checks the settings in the contract's order (W59). The integrator and its
// fee were checked when the module was created.
function checkSettings(input: EnrollInput): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || (input as unknown) === null) {
    throw new InvalidInputError(
      'settings must be { skim, monthlyCap, destination, withdrawalDay }',
    );
  }
  const { skim, monthlyCap, destination, withdrawalDay } = input;
  const percent = (skim as SkimSettings | undefined)?.percentBps;
  const unit = (skim as SkimSettings | undefined)?.roundUpUnit;
  const percentOk =
    percent === undefined ||
    (Number.isInteger(percent) &&
      percent >= MIN_PERCENT_BPS &&
      percent <= MAX_PERCENT_BPS);
  const unitOk = unit === undefined || (typeof unit === 'bigint' && unit > 0n);
  if (!percentOk || !unitOk || (percent === undefined && unit === undefined)) {
    throw new InvalidInputError(
      `skim needs percentBps from ${String(MIN_PERCENT_BPS)} to ${String(MAX_PERCENT_BPS)}, roundUpUnit above zero, or both (InvalidSkim)`,
    );
  }
  if (monthlyCap !== undefined) {
    checkPositive(monthlyCap, 'monthlyCap', 'InvalidCap');
  }
  if (
    !Number.isInteger(withdrawalDay) ||
    withdrawalDay < MIN_DAY ||
    withdrawalDay > MAX_DAY
  ) {
    throw new InvalidInputError(
      `withdrawalDay must be from ${String(MIN_DAY)} to ${String(MAX_DAY)} (InvalidDay)`,
    );
  }
  const kind = (destination as Destination | undefined)?.kind;
  if (kind === 'goal') {
    checkU64((destination as { goalId: unknown }).goalId, 'destination.goalId');
  } else if (kind !== 'balance') {
    throw new InvalidInputError(
      "destination must be { kind: 'balance' } or { kind: 'goal', goalId }",
    );
  }
  return {
    skim: { percent_bps: percent, round_up_unit: unit },
    monthly_cap: monthlyCap,
    destination: toRawDestination(destination),
    withdrawal_day: withdrawalDay,
  };
}

/**
 * Spend & Save for the configured `publicKey`, with one integrator. Every
 * write acts for `publicKey`, and every check that needs no chain data runs
 * before any network call.
 */
export class SpendSave {
  /** The integrator's address. */
  readonly integrator: string;
  /** The integrator fee a new enrolment receives. */
  readonly integratorFeeBps: number;
  private readonly loktin: Loktin;
  private readonly contractId: string;
  private readonly chain: Required<SpendSaveReadAdapter>;

  /** Checks the options, with no network call. */
  constructor(loktin: Loktin, options: IntegratorOptions) {
    this.loktin = loktin;
    this.contractId = loktin.config.contracts.spendSave;
    ({ integrator: this.integrator, integratorFeeBps: this.integratorFeeBps } =
      checkIntegrator(options, this.contractId));
    this.chain = chainReads(loktin);
  }

  private get adapter(): SpendSaveReadAdapter | undefined {
    return this.loktin.config.readAdapter?.spendSave;
  }

  /** Enrols `publicKey` with the integrator (P12, P13, P16, S9). */
  async enroll(input: EnrollInput): Promise<WriteResult<null>> {
    const user = writerOf(this.loktin.config);
    const settings = checkSettings(input);
    return this.loktin.write('spend-save', 'enroll', {
      user,
      integrator: this.integrator,
      integrator_fee_bps: this.integratorFeeBps,
      ...settings,
    });
  }

  /**
   * Replaces the skim settings, cap and destination at once. A new withdrawal
   * day takes effect from next month (P16, S9). Fee rates never change.
   */
  async updateSettings(input: EnrollInput): Promise<WriteResult<null>> {
    const user = writerOf(this.loktin.config);
    const settings = checkSettings(input);
    return this.loktin.write('spend-save', 'update_settings', {
      user,
      integrator: this.integrator,
      ...settings,
    });
  }

  /**
   * Pays `amount` from `publicKey` to `to`, an account (G), muxed account (M)
   * or contract (C) address, and saves the skim in the same call (P11, P14).
   */
  async payAndSave(to: string, amount: bigint): Promise<WriteResult<Saving>> {
    const user = writerOf(this.loktin.config);
    checkPositive(amount, 'amount', 'InvalidAmount');
    if (
      typeof to !== 'string' ||
      !(
        StrKey.isValidEd25519PublicKey(to) ||
        StrKey.isValidMed25519PublicKey(to) ||
        StrKey.isValidContract(to)
      )
    ) {
      throw new InvalidInputError(
        'to must be an account (G...), muxed account (M...) or contract (C...) address',
      );
    }
    // A payment to Spend & Save itself would be held with no record.
    if (to === this.contractId) {
      throw new InvalidInputError(
        'to must not be the Spend & Save contract (InvalidPayee)',
      );
    }
    const written = await this.loktin.write<RawSaving>(
      'spend-save',
      'pay_and_save',
      { user, integrator: this.integrator, to, amount },
    );
    return { ...written, result: toSaving(written.result) };
  }

  /** Saves the skim on a spend `publicKey` made by other means (P11). */
  async saveForSpend(spent: bigint): Promise<WriteResult<Saving>> {
    const user = writerOf(this.loktin.config);
    checkPositive(spent, 'spent', 'InvalidAmount');
    const written = await this.loktin.write<RawSaving>(
      'spend-save',
      'save_for_spend',
      { user, integrator: this.integrator, spent },
    );
    return { ...written, result: toSaving(written.result) };
  }

  /**
   * Withdraws `amount` from the balance. The chain refuses it outside the
   * withdrawal window (P16, S9, R2). The user receives `toUser`. The
   * integrator fee accrues to the integrator, and the Loktin fee to
   * Loktin's fee recipient, who each claim them with
   * {@link SpendSave.claimFees}.
   */
  async withdraw(amount: bigint): Promise<WriteResult<SpendSaveWithdrawal>> {
    const user = writerOf(this.loktin.config);
    checkPositive(amount, 'amount', 'InvalidAmount');
    const written = await this.loktin.write<RawWithdrawal>(
      'spend-save',
      'withdraw',
      { user, integrator: this.integrator, amount },
    );
    return { ...written, result: toWithdrawal(written.result) };
  }

  /** Closes the enrolment, whose balance must be zero (S9). */
  async close(): Promise<WriteResult<null>> {
    const user = writerOf(this.loktin.config);
    return this.loktin.write('spend-save', 'close', {
      user,
      integrator: this.integrator,
    });
  }

  /**
   * Returns the enrolment of `publicKey` with the integrator, and the
   * withdrawal day that applies now. `effectiveWithdrawalDay` is for display:
   * it uses the device clock in UTC, and at the edge of a month the chain
   * decides.
   */
  async enrollment(): Promise<EnrollmentView> {
    const user = userOf(this.loktin.config);
    const adapter = this.adapter;
    const enrollment = adapter?.enrollment
      ? await adapter.enrollment(user, this.integrator)
      : await this.chain.enrollment(user, this.integrator);
    return {
      ...enrollment,
      effectiveWithdrawalDay: effectiveWithdrawalDay(enrollment),
    };
  }

  /** Returns how a spend would be skimmed now, before the wallet is checked. */
  async previewSkim(spent: bigint): Promise<SkimPreview> {
    const user = userOf(this.loktin.config);
    const adapter = this.adapter;
    return adapter?.previewSkim
      ? adapter.previewSkim(user, this.integrator, spent)
      : this.chain.previewSkim(user, this.integrator, spent);
  }

  /** Returns how a withdrawal of `amount` would split. Does not check the withdrawal window. */
  async previewWithdraw(amount: bigint): Promise<SpendSaveWithdrawal> {
    const user = userOf(this.loktin.config);
    const adapter = this.adapter;
    return adapter?.previewWithdraw
      ? adapter.previewWithdraw(user, this.integrator, amount)
      : this.chain.previewWithdraw(user, this.integrator, amount);
  }

  /**
   * Returns the current withdrawal window if one is open, otherwise the next
   * one, with any pending day change applied. `end` is the first second after
   * the window.
   */
  async nextWindow(): Promise<TimeWindow> {
    const user = userOf(this.loktin.config);
    const adapter = this.adapter;
    return adapter?.nextWindow
      ? adapter.nextWindow(user, this.integrator)
      : this.chain.nextWindow(user, this.integrator);
  }

  /** Returns the Target Savings contract skims may go to, if any. */
  async targetSavings(): Promise<string | undefined> {
    const adapter = this.adapter;
    return adapter?.targetSavings
      ? adapter.targetSavings()
      : this.chain.targetSavings();
  }

  /** Returns the token Spend & Save holds. */
  async token(): Promise<string> {
    const adapter = this.adapter;
    return adapter?.token ? adapter.token() : this.chain.token();
  }

  /** Returns the Loktin fee rate new enrolments receive. */
  async loktinFeeBps(): Promise<number> {
    const adapter = this.adapter;
    return adapter?.loktinFeeBps
      ? adapter.loktinFeeBps()
      : this.chain.loktinFeeBps();
  }

  /** Returns the address Loktin fees are paid to. */
  async feeRecipient(): Promise<string> {
    const adapter = this.adapter;
    return adapter?.feeRecipient
      ? adapter.feeRecipient()
      : this.chain.feeRecipient();
  }

  /**
   * Pays out every fee accrued to `publicKey` and returns the amount
   * (W63). The call acts for `publicKey`, so it needs only the configured
   * signer. An integrator claims by creating the SDK with its own
   * `publicKey` and signer, and Loktin's fee recipient claims the same way.
   * With nothing accrued, the contract refuses it with `NothingToClaim`.
   * Never uses the read adapter.
   */
  async claimFees(): Promise<WriteResult<bigint>> {
    const recipient = writerOf(this.loktin.config);
    return this.loktin.write<bigint>('spend-save', 'claim_fees', { recipient });
  }

  /**
   * Returns the fees accrued to `recipient` and not yet claimed (W63).
   * `recipient` defaults to the module's integrator.
   */
  async accruedFees(recipient?: string): Promise<bigint> {
    const address =
      recipient === undefined
        ? this.integrator
        : checkAddress(recipient, 'recipient');
    const adapter = this.adapter;
    return adapter?.accruedFees
      ? adapter.accruedFees(address)
      : this.chain.accruedFees(address);
  }

  /** Returns whether Spend & Save is paused. */
  async paused(): Promise<boolean> {
    const adapter = this.adapter;
    return adapter?.paused ? adapter.paused() : this.chain.paused();
  }
}

// The built-in adapter: each read is one call through the core.
function chainReads(loktin: Loktin): Required<SpendSaveReadAdapter> {
  const read = <T>(method: string, args?: Record<string, unknown>) =>
    loktin.read<T>('spend-save', method, args);
  return {
    enrollment: async (user, integrator) =>
      toEnrollment(
        await read<RawEnrollment>('enrollment', { user, integrator }),
      ),
    previewSkim: async (user, integrator, spent) =>
      toSkimPreview(
        await read<RawSkimPreview>('preview_skim', { user, integrator, spent }),
      ),
    previewWithdraw: async (user, integrator, amount) =>
      toWithdrawal(
        await read<RawWithdrawal>('preview_withdraw', {
          user,
          integrator,
          amount,
        }),
      ),
    nextWindow: async (user, integrator) =>
      toWindow(
        await read<[bigint, bigint]>('next_window', { user, integrator }),
      ),
    targetSavings: async () =>
      (await read<string | null>('target_savings')) ?? undefined,
    token: () => read<string>('token'),
    loktinFeeBps: () => read<number>('loktin_fee_bps'),
    feeRecipient: () => read<string>('fee_recipient'),
    paused: () => read<boolean>('paused'),
    accruedFees: (recipient) => read<bigint>('accrued_fees', { recipient }),
  };
}
