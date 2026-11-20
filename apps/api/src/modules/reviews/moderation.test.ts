import { describe, expect, it } from 'vitest';
import { moderateText } from './moderation';

describe('review moderation (BR-REVIEW-004)', () => {
  it('removes phone numbers and e-mails', () => {
    expect(moderateText('Call me on +91 98765 43210 or 9876543210').text).toBe(
      'Call me on [removed] or [removed]',
    );
    expect(moderateText('mail a.b@example.com please').text).toBe('mail [removed] please');
  });
  it('masks profanity, keeps ordinary words and numbers', () => {
    const r = moderateText('Shit biryani, 2 pieces for 350, shitake fine');
    expect(r.text).toBe('S*** biryani, 2 pieces for 350, shitake fine');
    expect(r.changed).toBe(true);
    expect(moderateText('Lovely, hot and on time').changed).toBe(false);
  });
});
