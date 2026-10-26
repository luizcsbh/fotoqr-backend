import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import { pool } from '../config/database.js';
import { env } from '../config/env.js';

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const terminal = createInterface({ input: stdin, output: stdout });
    terminal.question(question, (answer) => {
      terminal.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Execute este comando em um terminal interativo.'));
  }

  return new Promise((resolve, reject) => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();

    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (input: Buffer) => {
      for (const character of input.toString()) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Operação cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const databaseUrl = new URL(env.DATABASE_URL);
  const databaseName = databaseUrl.pathname.replace(/^\//, '') || '(não informado)';
  stdout.write(`Banco configurado: ${databaseUrl.hostname}/${databaseName}\n`);
  stdout.write('Este comando altera a senha da conta nesse banco, inclusive se for produção.\n');

  const confirmation = await ask('Para continuar, digite ALTERAR SENHA: ');
  if (confirmation !== 'ALTERAR SENHA') {
    stdout.write('Operação cancelada; nenhuma senha foi alterada.\n');
    return;
  }

  const email = (await ask('E-mail da conta: ')).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    throw new Error('Informe um e-mail válido.');
  }

  const password = await askSecret('Nova senha (mínimo 8 caracteres; entrada oculta): ');
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('A senha deve ter pelo menos 8 caracteres e no máximo 72 bytes.');
  }
  const passwordConfirmation = await askSecret('Confirme a nova senha: ');
  if (password !== passwordConfirmation) {
    throw new Error('As senhas não coincidem.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `UPDATE users
     SET password_hash = $1, updated_at = NOW()
     WHERE lower(email) = $2 AND password_hash IS NOT NULL
     RETURNING id`,
    [passwordHash, email]
  );

  if (result.rowCount !== 1) {
    throw new Error('Não foi encontrada uma única conta com senha para esse e-mail no banco informado.');
  }

  stdout.write('Senha alterada. Entre com a nova senha; ela não foi exibida nem registrada pelo comando.\n');
}

main()
  .catch((error: unknown) => {
    stdout.write(`${error instanceof Error ? error.message : 'Não foi possível alterar a senha.'}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
