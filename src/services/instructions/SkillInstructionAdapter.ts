import type { InstructionSkillMutationPort, InstructionSkillPort, PreparedInstruction, ServiceResult, SkillReference } from './types';

export class SkillInstructionAdapter {
  constructor(readonly port: InstructionSkillPort, readonly mutations?: InstructionSkillMutationPort) {}

  prepare(references: readonly SkillReference[]): Promise<ServiceResult<PreparedInstruction[]>> {
    return this.port.prepareMany(references);
  }
}
