import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/code-review.yml', 'utf8'));
const [gate, review] = workflow.jobs.review.steps;
// Exercise the actual inline gate, not a separate copy of its authorization rules.
const authorize = new Function('context', 'github', 'core', `return (async () => {${gate.with.script}})()`);

function fixture(eventName = 'pull_request_target') {
  return {
    context: {
      eventName,
      repo: { owner: 'hgschmie', repo: 'openrouter-review' },
      payload: {
        action: eventName === 'issue_comment' ? 'created' : 'opened',
        sender: { login: 'hgschmie', type: 'User' },
        pull_request: { number: 12, user: { login: 'hgschmie', type: 'User' } },
        issue: { number: 12, pull_request: {} as object | undefined },
        comment: {
          user: { login: 'hgschmie', type: 'User' },
          author_association: 'OWNER',
          body: '@code-review',
        },
      },
    },
    pr: {
      base: { ref: 'main', repo: { full_name: 'hgschmie/openrouter-review' } },
      user: { login: eventName === 'issue_comment' ? 'outside-contributor' : 'hgschmie', type: 'User' },
      state: 'open',
      draft: false,
      locked: false,
    },
  };
}

async function evaluate(input: ReturnType<typeof fixture>) {
  const requests: unknown[] = [];
  const result = await authorize(
    input.context,
    {
      rest: {
        pulls: {
          get: async (params: unknown) => {
            requests.push(params);
            return { data: input.pr };
          },
        },
      },
    },
    { notice: () => {} },
  );
  return { result, requests };
}

for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
  test(`workflow automatically reviews owner PR on ${action}`, async () => {
    const input = fixture();
    input.context.payload.action = action;
    assert.equal((await evaluate(input)).result, true);
  });
}

test('owner comment explicitly approves a review of an outside PR', async () => {
  const { result, requests } = await evaluate(fixture('issue_comment'));
  assert.equal(result, true);
  assert.deepEqual(requests, [{ owner: 'hgschmie', repo: 'openrouter-review', pull_number: 12 }]);
});

test('PR lookup failure cannot authorize a review', async () => {
  await assert.rejects(
    authorize(
      fixture('issue_comment').context,
      {
        rest: {
          pulls: {
            get: async () => {
              throw new Error('GitHub unavailable');
            },
          },
        },
      },
      { notice: () => {} },
    ),
    /GitHub unavailable/,
  );
});

const denied: [string, string, (input: ReturnType<typeof fixture>) => void][] = [
  [
    'outside PR, even when reopened by owner',
    'pull_request_target',
    (x) => {
      x.context.payload.pull_request.user.login = 'outsider';
    },
  ],
  [
    'outside push to an owner PR',
    'pull_request_target',
    (x) => {
      x.context.payload.sender.login = 'outsider';
    },
  ],
  [
    'label event',
    'pull_request_target',
    (x) => {
      x.context.payload.action = 'labeled';
    },
  ],
  [
    'outside comment',
    'issue_comment',
    (x) => {
      x.context.payload.comment.user.login = 'outsider';
    },
  ],
  [
    'outside sender',
    'issue_comment',
    (x) => {
      x.context.payload.sender.login = 'outsider';
    },
  ],
  [
    'bot comment',
    'issue_comment',
    (x) => {
      x.context.payload.comment.user.type = 'Bot';
    },
  ],
  [
    'bot sender',
    'issue_comment',
    (x) => {
      x.context.payload.sender.type = 'Bot';
    },
  ],
  [
    'collaborator association',
    'issue_comment',
    (x) => {
      x.context.payload.comment.author_association = 'COLLABORATOR';
    },
  ],
  [
    'edited comment',
    'issue_comment',
    (x) => {
      x.context.payload.action = 'edited';
    },
  ],
  [
    'ordinary issue',
    'issue_comment',
    (x) => {
      x.context.payload.issue.pull_request = undefined;
    },
  ],
  [
    'quoted command',
    'issue_comment',
    (x) => {
      x.context.payload.comment.body = '> @code-review';
    },
  ],
  [
    'extra instructions',
    'issue_comment',
    (x) => {
      x.context.payload.comment.body = '@code-review please';
    },
  ],
  [
    'partial mention',
    'issue_comment',
    (x) => {
      x.context.payload.comment.body = '@code-review-other';
    },
  ],
  ['unrelated event', 'push', () => {}],
];
for (const [name, eventName, mutate] of denied) {
  test(`workflow denies ${name} before accessing the PR`, async () => {
    const input = fixture(eventName);
    mutate(input);
    assert.deepEqual(await evaluate(input), { result: false, requests: [] });
  });
}

for (const eventName of ['pull_request_target', 'issue_comment']) {
  for (const [name, mutate] of [
    [
      'another target branch',
      (x) => {
        x.pr.base.ref = 'release';
      },
    ],
    [
      'another repository',
      (x) => {
        x.pr.base.repo.full_name = 'outsider/openrouter-review';
      },
    ],
    [
      'closed PR',
      (x) => {
        x.pr.state = 'closed';
      },
    ],
    [
      'draft PR',
      (x) => {
        x.pr.draft = true;
      },
    ],
    [
      'locked PR',
      (x) => {
        x.pr.locked = true;
      },
    ],
  ] as [string, (input: ReturnType<typeof fixture>) => void][]) {
    test(`workflow rejects ${name} on ${eventName}`, async () => {
      const input = fixture(eventName);
      mutate(input);
      assert.equal((await evaluate(input)).result, false);
    });
  }
}

test('review credentials remain behind the gate and only pinned actions execute', () => {
  assert.deepEqual(workflow.on.pull_request_target.branches, ['main']);
  assert.deepEqual(workflow.on.issue_comment.types, ['created']);
  assert.deepEqual(workflow.permissions, { contents: 'read', 'pull-requests': 'write' });
  assert.equal(workflow.jobs.review.steps.length, 2);
  assert.equal(gate.id, 'gate');
  assert.equal(review.if, "steps.gate.outputs.result == 'true'");
  assert.equal(review.with['api-key'], '${{ secrets.OPENROUTER_API_KEY }}');
  assert.equal(review.with['allowed-associations'], 'OWNER');
  assert.equal(review.with['watch-mention'], '@code-review');
  assert.doesNotMatch(gate.with.script, /\$\{\{/);
  for (const step of [gate, review]) {
    assert.match(step.uses, /^(actions\/github-script|hgschmie\/openrouter-review)@[a-f0-9]{40}$/);
    assert.equal(step.run, undefined);
  }
});
