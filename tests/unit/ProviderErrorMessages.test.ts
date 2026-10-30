import { describeOverloadRetry, describeProviderHttpFailure } from '../../src/services/llm/adapters/shared/ProviderErrorMessages';

describe('describeProviderHttpFailure', () => {
  it.each([
    [503, 'Google AI is overloaded right now. Wait a moment and try again, or switch to a different model. (HTTP 503)'],
    [529, 'Google AI is overloaded right now. Wait a moment and try again, or switch to a different model. (HTTP 529)'],
    [401, 'Google AI did not accept the API key. Check it in Nexus settings under Providers. (HTTP 401)'],
    [403, 'Google AI refused access to this model: raw detail (HTTP 403)'],
    [404, 'Google AI could not find this model. It may be retired or unavailable to your account; choose another model. (HTTP 404)'],
    [504, 'Google AI took too long to respond. Try again. (HTTP 504)'],
    [500, 'Google AI had a server error. Try again in a moment. (HTTP 500)'],
    [400, 'Google AI rejected the request: raw detail (HTTP 400)'],
  ])('describes HTTP %i in plain language', (status, expected) => {
    expect(describeProviderHttpFailure('google', status, 'raw detail')).toBe(expected);
  });

  it('turns a quota message into a wait time and drops the raw quota dump', () => {
    const detail = 'You exceeded your current quota, please check your plan and billing details. ' +
      '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10 Please retry in 27.5s.';
    expect(describeProviderHttpFailure('google', 429, detail)).toBe(
      'Google AI says you have hit a rate limit or usage quota. Try again in 28 seconds. ' +
      'If this keeps happening, check your plan and usage limits with the provider. (HTTP 429)'
    );
  });

  it('falls back to a generic wait and provider name', () => {
    expect(describeProviderHttpFailure('custom-endpoint-id', 429, '')).toBe(
      'The AI provider says you have hit a rate limit or usage quota. Wait a minute and try again. ' +
      'If this keeps happening, check your plan and usage limits with the provider. (HTTP 429)'
    );
  });

  it('ends a bad-request sentence cleanly when the provider gave no explanation', () => {
    expect(describeProviderHttpFailure('anthropic', 400, '')).toBe('Anthropic rejected the request. (HTTP 400)');
  });
});

describe('describeOverloadRetry', () => {
  it('names the provider and counts the retry as X/Y', () => {
    expect(describeOverloadRetry('google', 2, 4)).toBe('Google AI is overloaded. Retrying 2/4…');
    expect(describeOverloadRetry(undefined, 1, 4)).toBe('The AI provider is overloaded. Retrying 1/4…');
  });
});
