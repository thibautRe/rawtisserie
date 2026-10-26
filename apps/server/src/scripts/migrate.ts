import createConnectionPool from '@databases/pg';
import { migrate } from '../migrate.ts';

const connection = createConnectionPool({ connectionString: process.env.DATABASE_URL, bigIntMode: 'number' });
try {
  await migrate(connection);
  console.log('Migrations applied.');
} finally {
  await connection.dispose();
}
