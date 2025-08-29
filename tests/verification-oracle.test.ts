import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Oracle {
  oraclePrincipal: string;
  name: string;
  description: string;
  active: boolean;
  addedAt: number;
  reputation: number;
}

interface VerifiedData {
  emissionReduction: number;
  metadata: string;
  timestamp: number;
  verifyingOracles: number[];
  consensusReached: boolean;
  expiry: number;
}

interface ContractState {
  contractOwner: string;
  oracleAdmin: string;
  contractPaused: boolean;
  oracleCounter: number;
  trustedOracles: Map<number, Oracle>;
  verifiedData: Map<string, VerifiedData>; // Key: `${user}-${initiativeId}-${submissionId}`
  submissionCounter: Map<string, number>; // Key: `${user}-${initiativeId}`
}

// Mock contract implementation
class VerificationOracleMock {
  private state: ContractState = {
    contractOwner: "deployer",
    oracleAdmin: "deployer",
    contractPaused: false,
    oracleCounter: 0,
    trustedOracles: new Map(),
    verifiedData: new Map(),
    submissionCounter: new Map(),
  };

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_INVALID_DATA = 101;
  private ERR_INITIATIVE_NOT_FOUND = 102;
  private ERR_ORACLE_ALREADY_EXISTS = 103;
  private ERR_ORACLE_NOT_FOUND = 104;
  private ERR_EXPIRED_DATA = 105;
  private ERR_INVALID_INITIATIVE_ID = 106;
  private ERR_INVALID_EMISSION_REDUCTION = 107;
  private ERR_INVALID_METADATA = 108;
  private ERR_CONTRACT_PAUSED = 109;
  private ERR_INVALID_TIMESTAMP = 110;
  private ERR_DUPLICATE_SUBMISSION = 111;
  private ERR_INSUFFICIENT_ORACLE_AGREEMENT = 112;
  private MAX_METADATA_LEN = 500;
  private DATA_EXPIRY_BLOCKS = 1440;
  private MIN_ORACLE_AGREEMENT = 2;
  private currentBlockHeight = 1000; // Mock block height

  // Mock external call to InitiativeRegistry
  private mockInitiativeRegistry: Map<number, { minReduction: number; maxReduction: number }> = new Map([
    [1, { minReduction: 100, maxReduction: 10000 }],
  ]);

  private getInitiative(initiativeId: number) {
    const details = this.mockInitiativeRegistry.get(initiativeId);
    if (details) {
      return { ok: true, value: details };
    }
    return { ok: false, value: this.ERR_INITIATIVE_NOT_FOUND };
  }

  // Simulate block height increase
  advanceBlock() {
    this.currentBlockHeight += 1;
  }

  submitVerification(
    caller: string,
    user: string,
    initiativeId: number,
    emissionReduction: number,
    metadata: string,
    oracleId: number
  ): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const oracle = this.state.trustedOracles.get(oracleId);
    if (!oracle || !oracle.active || oracle.oraclePrincipal !== caller) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const initiative = this.getInitiative(initiativeId);
    if (!initiative.ok || emissionReduction < initiative.value.minReduction || emissionReduction > initiative.value.maxReduction) {
      return { ok: false, value: this.ERR_INVALID_EMISSION_REDUCTION };
    }
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_INVALID_METADATA };
    }
    const counterKey = `${user}-${initiativeId}`;
    const submissionId = (this.state.submissionCounter.get(counterKey) ?? 0) + 1;
    this.state.submissionCounter.set(counterKey, submissionId);
    const dataKey = `${user}-${initiativeId}-${submissionId}`;
    if (this.state.verifiedData.has(dataKey)) {
      return { ok: false, value: this.ERR_DUPLICATE_SUBMISSION };
    }
    this.state.verifiedData.set(dataKey, {
      emissionReduction,
      metadata,
      timestamp: this.currentBlockHeight,
      verifyingOracles: [oracleId],
      consensusReached: false,
      expiry: this.currentBlockHeight + this.DATA_EXPIRY_BLOCKS,
    });
    const consensus = this.checkConsensus(dataKey);
    return { ok: true, value: consensus };
  }

  addTrustedOracle(
    caller: string,
    oraclePrincipal: string,
    name: string,
    description: string
  ): ClarityResponse<number> {
    if (caller !== this.state.oracleAdmin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    for (const oracle of this.state.trustedOracles.values()) {
      if (oracle.oraclePrincipal === oraclePrincipal) {
        return { ok: false, value: this.ERR_ORACLE_ALREADY_EXISTS };
      }
    }
    const newId = this.state.oracleCounter + 1;
    this.state.oracleCounter = newId;
    this.state.trustedOracles.set(newId, {
      oraclePrincipal,
      name,
      description,
      active: true,
      addedAt: this.currentBlockHeight,
      reputation: 100,
    });
    return { ok: true, value: newId };
  }

  removeTrustedOracle(caller: string, oracleId: number): ClarityResponse<boolean> {
    if (caller !== this.state.oracleAdmin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const oracle = this.state.trustedOracles.get(oracleId);
    if (!oracle) {
      return { ok: false, value: this.ERR_ORACLE_NOT_FOUND };
    }
    oracle.active = false;
    return { ok: true, value: true };
  }

  updateOracleReputation(caller: string, oracleId: number, newReputation: number): ClarityResponse<boolean> {
    if (caller !== this.state.oracleAdmin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const oracle = this.state.trustedOracles.get(oracleId);
    if (!oracle) {
      return { ok: false, value: this.ERR_ORACLE_NOT_FOUND };
    }
    oracle.reputation = newReputation;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  transferAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.oracleAdmin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.oracleAdmin = newAdmin;
    return { ok: true, value: true };
  }

  verifyEmissionData(user: string, initiativeId: number, submissionId: number): ClarityResponse<number> {
    const dataKey = `${user}-${initiativeId}-${submissionId}`;
    const data = this.state.verifiedData.get(dataKey);
    if (!data || !data.consensusReached || this.currentBlockHeight >= data.expiry) {
      return { ok: false, value: this.ERR_INVALID_DATA };
    }
    return { ok: true, value: data.emissionReduction };
  }

  getVerifiedData(user: string, initiativeId: number, submissionId: number): ClarityResponse<VerifiedData | null> {
    const dataKey = `${user}-${initiativeId}-${submissionId}`;
    return { ok: true, value: this.state.verifiedData.get(dataKey) ?? null };
  }

  getOracleDetails(oracleId: number): ClarityResponse<Oracle | null> {
    return { ok: true, value: this.state.trustedOracles.get(oracleId) ?? null };
  }

  getSubmissionCount(user: string, initiativeId: number): ClarityResponse<number> {
    const counterKey = `${user}-${initiativeId}`;
    return { ok: true, value: this.state.submissionCounter.get(counterKey) ?? 0 };
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.contractPaused };
  }

  addVerificationToSubmission(
    caller: string,
    user: string,
    initiativeId: number,
    submissionId: number,
    oracleId: number,
    agreedReduction: number,
    metadata: string
  ): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const oracle = this.state.trustedOracles.get(oracleId);
    if (!oracle || !oracle.active || oracle.oraclePrincipal !== caller) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const dataKey = `${user}-${initiativeId}-${submissionId}`;
    const data = this.state.verifiedData.get(dataKey);
    if (!data) {
      return { ok: false, value: this.ERR_INVALID_DATA };
    }
    if (data.emissionReduction !== agreedReduction) {
      return { ok: false, value: this.ERR_INVALID_DATA };
    }
    if (data.verifyingOracles.includes(oracleId)) {
      return { ok: false, value: this.ERR_DUPLICATE_SUBMISSION };
    }
    data.verifyingOracles.push(oracleId);
    const consensus = this.checkConsensus(dataKey);
    return { ok: true, value: consensus };
  }

  private checkConsensus(dataKey: string): boolean {
    const data = this.state.verifiedData.get(dataKey);
    if (!data) return false;
    const agreement = data.verifyingOracles.length >= this.MIN_ORACLE_AGREEMENT;
    if (agreement) {
      data.consensusReached = true;
    }
    return agreement;
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  oracle1: "oracle1",
  oracle2: "oracle2",
  user1: "user1",
};

describe("VerificationOracle Contract", () => {
  let contract: VerificationOracleMock;

  beforeEach(() => {
    contract = new VerificationOracleMock();
    vi.resetAllMocks();
  });

  it("should allow admin to add trusted oracle", () => {
    const addOracle = contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Reliable data provider");
    expect(addOracle.ok).toBe(true);
    expect(addOracle.value).toBe(1);

    const oracleDetails = contract.getOracleDetails(1);
    expect(oracleDetails.ok).toBe(true);
    expect(oracleDetails.value).toEqual(expect.objectContaining({ oraclePrincipal: accounts.oracle1, active: true }));
  });

  it("should prevent non-admin from adding oracle", () => {
    const addOracle = contract.addTrustedOracle(accounts.user1, accounts.oracle1, "Oracle One", "Description");
    expect(addOracle.ok).toBe(false);
    expect(addOracle.value).toBe(100);
  });

  it("should allow oracle to submit verification", () => {
    contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Description");
    const submit = contract.submitVerification(accounts.oracle1, accounts.user1, 1, 500, "Solar panel data", 1);
    expect(submit.ok).toBe(true);
    expect(submit.value).toBe(false); // No consensus yet since MIN=2

    const data = contract.getVerifiedData(accounts.user1, 1, 1);
    expect(data.ok).toBe(true);
    expect(data.value).toEqual(expect.objectContaining({ emissionReduction: 500 }));
  });

  it("should prevent unauthorized submission", () => {
    const submit = contract.submitVerification(accounts.user1, accounts.user1, 1, 500, "Data", 1);
    expect(submit.ok).toBe(false);
    expect(submit.value).toBe(100);
  });

  it("should validate emission reduction against initiative", () => {
    contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Description");
    const submitLow = contract.submitVerification(accounts.oracle1, accounts.user1, 1, 50, "Data", 1);
    expect(submitLow.ok).toBe(false);
    expect(submitLow.value).toBe(107);
  });

  it("should add verification from second oracle and reach consensus", () => {
    contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Description");
    contract.addTrustedOracle(accounts.deployer, accounts.oracle2, "Oracle Two", "Description");
    contract.submitVerification(accounts.oracle1, accounts.user1, 1, 500, "Data", 1);

    const addVerification = contract.addVerificationToSubmission(accounts.oracle2, accounts.user1, 1, 1, 2, 500, "Data");
    expect(addVerification.ok).toBe(true);
    expect(addVerification.value).toBe(true); // Consensus reached

    const verify = contract.verifyEmissionData(accounts.user1, 1, 1);
    expect(verify.ok).toBe(true);
    expect(verify.value).toBe(500);
  });

  it("should prevent adding verification with mismatched reduction", () => {
    contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Description");
    contract.addTrustedOracle(accounts.deployer, accounts.oracle2, "Oracle Two", "Description");
    contract.submitVerification(accounts.oracle1, accounts.user1, 1, 500, "Data", 1);

    const addVerification = contract.addVerificationToSubmission(accounts.oracle2, accounts.user1, 1, 1, 2, 600, "Data");
    expect(addVerification.ok).toBe(false);
    expect(addVerification.value).toBe(101);
  });

  it("should expire data after expiry blocks", () => {
    contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Description");
    contract.addTrustedOracle(accounts.deployer, accounts.oracle2, "Oracle Two", "Description");
    contract.submitVerification(accounts.oracle1, accounts.user1, 1, 500, "Data", 1);
    contract.addVerificationToSubmission(accounts.oracle2, accounts.user1, 1, 1, 2, 500, "Data");

    for (let i = 0; i < 1441; i++) {
      contract.advanceBlock();
    }

    const verify = contract.verifyEmissionData(accounts.user1, 1, 1);
    expect(verify.ok).toBe(false);
    expect(verify.value).toBe(101);
  });

  it("should pause and unpause contract", () => {
    const pause = contract.pauseContract(accounts.deployer);
    expect(pause.ok).toBe(true);
    expect(contract.isPaused().value).toBe(true);

    const submitDuringPause = contract.submitVerification(accounts.oracle1, accounts.user1, 1, 500, "Data", 1);
    expect(submitDuringPause.ok).toBe(false);
    expect(submitDuringPause.value).toBe(109);

    const unpause = contract.unpauseContract(accounts.deployer);
    expect(unpause.ok).toBe(true);
    expect(contract.isPaused().value).toBe(false);
  });

  it("should update oracle reputation", () => {
    contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Description");
    const update = contract.updateOracleReputation(accounts.deployer, 1, 200);
    expect(update.ok).toBe(true);

    const details = contract.getOracleDetails(1);
    expect(details.value?.reputation).toBe(200);
  });

  it("should get submission count", () => {
    contract.addTrustedOracle(accounts.deployer, accounts.oracle1, "Oracle One", "Description");
    contract.submitVerification(accounts.oracle1, accounts.user1, 1, 500, "Data", 1);
    const count = contract.getSubmissionCount(accounts.user1, 1);
    expect(count.value).toBe(1);
  });
});