import { useState } from "react";
import type { AppConfig, PullRequestDetail } from "../../../src/application/api.js";
import type { Engine } from "../../../src/domain/deliberation/model.js";
import type { Strings } from "../state/i18n.js";
import { Icon } from "./primitives.js";

export function engineLabel(engine: Engine, model: string | null, t: Strings): string {
  return model ? `${t.engineName[engine]} · ${model}` : t.engineName[engine];
}

export interface ConveneControlProps {
  readonly t: Strings;
  readonly config: AppConfig;
  readonly detail: PullRequestDetail;
  readonly convening: boolean;
  /** The council already met on this pull request. */
  readonly again?: boolean;
  /** A quieter button, for when something else on screen is the main thing. */
  readonly quiet?: boolean;
  onConvene(engine?: Engine): void;
}

/** Calls the council to session, with a choice of engine when more than one can review this pull request. */
export function ConveneControl({ t, config, detail, convening, again = false, quiet = false, onConvene }: ConveneControlProps) {
  const [picked, setPicked] = useState<Engine | null>(null);
  const { engines } = detail;
  const engine = picked && engines.includes(picked) ? picked : engines[0];
  if (!engine) return <p className="muted">{t.noEngine}</p>;
  const modelOf = (candidate: Engine) => config.engines.find((info) => info.engine === candidate)?.model ?? null;
  return (
    <span className="convene">
      <button type="button" className={`btn${quiet ? "" : " btn--primary"}`} disabled={convening} onClick={() => onConvene(engine)}>
        <Icon name="play" size={14} />
        {convening ? t.convening : again ? t.conveneAgain : t.convene}
      </button>
      {engines.length > 1 ? (
        <select className="select" value={engine} aria-label={t.theCouncil} onChange={(event) => setPicked(event.target.value as Engine)}>
          {engines.map((candidate) => (
            <option key={candidate} value={candidate}>
              {engineLabel(candidate, modelOf(candidate), t)}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}
