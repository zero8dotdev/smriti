/** `rules` on the new blueprint - genuinely unimplemented (see index.ts, every subcommand branch is a TODO). */

import { BaseStubCommand } from "../command";

export class RulesCommand extends BaseStubCommand {
  name = "rules";
  summary = "Manage custom classification rules";
  detailedSummary =
    "Coming in Phase 1 completion. Today's CLI accepts list|add|validate|update subcommands " +
    "but every branch only prints a placeholder.";
}
