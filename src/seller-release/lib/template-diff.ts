type Section = Record<string, { Type?: string; Properties?: unknown }>;
interface TemplateLike { Parameters?: Section; Resources?: Section }

export interface TemplateChangeSummary {
  baseline: 'previous-release' | 'none';
  parametersAdded: string[];
  parametersRemoved: string[];
  resourcesAdded: string[];
  resourcesRemoved: string[];
  resourcesModified: string[];
  resourcesTypeChanged: string[];
  /** Removed parameters/resources or changed resource types break in-place customer upgrades. */
  breaking: boolean;
  markdown: string;
}

const keys = (s?: Section) => Object.keys(s ?? {}).sort();

/** Static comparison of two templates for the approval summary. CloudFormation change sets remain authoritative. */
export function summarizeTemplateChanges(previous: TemplateLike | undefined, next: TemplateLike): TemplateChangeSummary {
  const p = previous ?? {};
  const prevRes = p.Resources ?? {};
  const nextRes = next.Resources ?? {};
  const s = {
    baseline: previous ? 'previous-release' as const : 'none' as const,
    parametersAdded: keys(next.Parameters).filter((k) => !(k in (p.Parameters ?? {}))),
    parametersRemoved: keys(p.Parameters).filter((k) => !(k in (next.Parameters ?? {}))),
    resourcesAdded: keys(nextRes).filter((k) => !(k in prevRes)),
    resourcesRemoved: keys(prevRes).filter((k) => !(k in nextRes)),
    resourcesTypeChanged: keys(nextRes).filter((k) => k in prevRes && prevRes[k].Type !== nextRes[k].Type),
    resourcesModified: keys(nextRes).filter((k) => k in prevRes && prevRes[k].Type === nextRes[k].Type && JSON.stringify(prevRes[k]) !== JSON.stringify(nextRes[k])),
  };
  const breaking = previous !== undefined && (s.parametersRemoved.length + s.resourcesRemoved.length + s.resourcesTypeChanged.length > 0);
  const line = (label: string, items: string[]) => `- ${label}: ${items.length > 0 ? items.join(', ') : 'none'}`;
  const markdown = [
    previous ? 'Compared with the previous release template.' : 'No previous release template: first release.',
    line('Added parameters', s.parametersAdded),
    line('Removed parameters', s.parametersRemoved),
    line('Added resources', s.resourcesAdded),
    line('Removed resources', s.resourcesRemoved),
    line('Modified resources', s.resourcesModified),
    line('Resources with changed type (replacement)', s.resourcesTypeChanged),
    breaking ? '**Breaking for in-place upgrades: requires a documented migration.**' : '',
  ].filter(Boolean).join('\n');
  return { ...s, breaking, markdown };
}
