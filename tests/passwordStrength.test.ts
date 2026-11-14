import { describe, it, expect } from 'vitest';
import { validateNewPasswordStrength } from '../src/services/auth.service.js';

describe('validateNewPasswordStrength', () => {
  it('accepts a password with upper, lower, number and special character', () => {
    expect(() => validateNewPasswordStrength('Festa@2026')).not.toThrow();
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(() => validateNewPasswordStrength('Ab1@xyz')).toThrow(/8 caracteres/);
  });

  it('names every missing rule', () => {
    expect(() => validateNewPasswordStrength('abcdefgh')).toThrow(
      /uma letra maiúscula, um número, um caractere especial/
    );
    expect(() => validateNewPasswordStrength('ABCDEFG1!')).toThrow(/uma letra minúscula/);
  });
});

describe('registration password rules', () => {
  it('rejects a weak password before touching the database', async () => {
    const { registerWithPassword } = await import('../src/services/auth.service.js');
    await expect(
      registerWithPassword({ name: 'Ana Silva', email: 'ana@example.com', password: 'senhafraca' })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/maiúscula/) });
  });
});
