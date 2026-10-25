import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool, checkDatabaseConnection } from './config/database.js';
import { logger } from './utils/logger.js';

async function startServer() {
  const app = createApp();
  const PORT = env.PORT;

  logger.info(`Iniciando servidor FotoQR Backend em modo [${env.NODE_ENV}]...`);

  // Verify Database Connection (with Neon.tech cold-start tolerance)
  try {
    const isConnected = await checkDatabaseConnection();
    if (isConnected) {
      logger.info('Conexão com PostgreSQL (Neon.tech) estabelecida com sucesso.');
    } else {
      logger.warn(
        'Aviso: O banco de dados não respondeu de imediato (possível cold start). O servidor continuará aguardando conexões.'
      );
    }
  } catch (err) {
    logger.warn('Erro durante a verificação inicial do banco de dados:', err);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Servidor FotoQR rodando com sucesso na porta ${PORT} em 0.0.0.0`);
    logger.info(`URL pública do backend: ${env.BACKEND_PUBLIC_URL}`);
    logger.info(`Origem frontend permitida: ${env.FRONTEND_URL}`);
  });

  // Graceful Shutdown handler
  const shutdown = async (signal: string) => {
    logger.info(`Sinal ${signal} recebido. Encerrando servidor graciosamente...`);

    server.close(async () => {
      logger.info('Servidor HTTP encerrado.');
      try {
        await pool.end();
        logger.info('Pool de conexões com o PostgreSQL encerrado.');
        process.exit(0);
      } catch (err) {
        logger.error('Erro ao encerrar o pool de conexões:', err);
        process.exit(1);
      }
    });

    // Force shutdown after timeout if pending connections hang
    setTimeout(() => {
      logger.error('Tempo limite de encerramento excedido. Forçando encerramento.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((error) => {
  logger.error('Falha crítica ao iniciar o servidor:', error);
  process.exit(1);
});
