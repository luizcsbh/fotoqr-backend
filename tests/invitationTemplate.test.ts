import { describe, it, expect } from 'vitest';
import { parseInvitationTemplate } from '../src/routes/invitation.routes.js';

describe('parseInvitationTemplate', () => {
  it('keeps a template slug', () => {
    expect(parseInvitationTemplate('aniv-confete')).toBe('aniv-confete');
  });

  it('clears the template with an empty value', () => {
    expect(parseInvitationTemplate('')).toBeNull();
    expect(parseInvitationTemplate(null)).toBeNull();
  });

  it('rejects anything that is not a short slug', () => {
    expect(parseInvitationTemplate('<script>')).toBeUndefined();
    expect(parseInvitationTemplate('Aniv Confete')).toBeUndefined();
    expect(parseInvitationTemplate('a'.repeat(51))).toBeUndefined();
    expect(parseInvitationTemplate(42)).toBeUndefined();
  });
});
