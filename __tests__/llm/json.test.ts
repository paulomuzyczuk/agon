import { extractJson } from '@/services/llm/json';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('strips a ```json code fence', () => {
    const text = '```json\n{"a":1}\n```';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it('strips a bare ``` fence', () => {
    expect(extractJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('extracts an object embedded in surrounding prose', () => {
    const text = 'Here is the result: {"a":3, "b":[1,2]} — done.';
    expect(extractJson(text)).toEqual({ a: 3, b: [1, 2] });
  });

  it('parses a top-level array', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('no json here')).toThrow(/no JSON/);
  });
});
