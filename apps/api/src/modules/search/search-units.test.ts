import { describe, expect, it } from 'vitest';
import { prefixQuery, searchTokens } from './search.service';

describe('search query building (FR-SRCH-001, ADR-009)', () => {
  it('lowercases, strips accents and punctuation, and keeps letters and digits', () => {
    expect(searchTokens('  Crème Brûlée!! ')).toEqual(['creme', 'brulee']);
    expect(searchTokens('Chicken-65')).toEqual(['chicken', '65']);
    expect(searchTokens('पनीर टिक्का').length).toBeGreaterThan(0);
  });

  it('cannot inject tsquery operators', () => {
    const tokens = searchTokens("pizza' | !(:*) & <-> x");
    expect(prefixQuery(tokens)).toBe('pizza:* & x:*');
  });

  it('caps the number of words', () => {
    expect(searchTokens('a b c d e f g h i j')).toHaveLength(8);
  });
});
