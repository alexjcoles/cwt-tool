// Minimal Linear GraphQL client used by the dashboard's "new worktree" flow
// to enrich an issue id (AMPHTT-929) with a title and Linear-generated branch
// name. Only a single read query — keeping scope tight.
//
// Auth: set LINEAR_API_KEY in the environment.
//   $ export LINEAR_API_KEY=lin_api_xxxx
// Get a key at https://linear.app/settings/api.

const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearIssue {
  identifier: string; // e.g. "AMPHTT-929"
  title: string;
  gitBranchName: string; // user's configured branch name, e.g. "alexc/amphtt-929-foo-bar"
  url: string;
}

export class LinearAuthMissingError extends Error {
  constructor() {
    super(
      "LINEAR_API_KEY is not set — get one at https://linear.app/settings/api and export it.",
    );
    this.name = "LinearAuthMissingError";
  }
}

export async function fetchIssue(identifier: string): Promise<LinearIssue | null> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new LinearAuthMissingError();

  // Linear's GraphQL accepts the human identifier ("AMPHTT-929") directly
  // for the `issue(id:)` query in recent API versions.
  const query = `
    query CwtIssueLookup($id: String!) {
      issue(id: $id) {
        identifier
        title
        gitBranchName
        url
      }
    }
  `;

  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables: { id: identifier } }),
  });

  if (!res.ok) {
    throw new Error(
      `Linear API ${res.status}: ${res.statusText} (have you set LINEAR_API_KEY correctly?)`,
    );
  }

  const json = (await res.json()) as {
    data?: { issue?: LinearIssue | null };
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  return json.data?.issue ?? null;
}

// Derive a worktree name (cwt's NAME_PATTERN: lowercase, digits, hyphens) from
// a Linear issue's identifier + title. Examples:
//   identifier="AMPHTT-929" title="OIDC: disambiguate multi-email matches"
//     → "amphtt-929-oidc-disambiguate-multi-email-matches"
// Truncates if the result would exceed `maxLen`.
export function worktreeNameFromIssue(
  issue: Pick<LinearIssue, "identifier" | "title">,
  maxLen = 60,
): string {
  const base = issue.identifier.toLowerCase();
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return base;
  const combined = `${base}-${slug}`;
  if (combined.length <= maxLen) return combined;
  // Truncate slug, never the identifier
  const room = maxLen - base.length - 1;
  if (room <= 3) return base;
  const truncated = slug.slice(0, room).replace(/-+$/, "");
  return `${base}-${truncated}`;
}
