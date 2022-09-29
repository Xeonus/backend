import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { commandSync } from 'execa';
import { setPrisma } from '../../prisma/prisma-client';
import { TestDatabaseContainer } from './jest-test-helpers';

export type TestDatabasePrismaConfig = {
    generateClient: boolean;
    schemaFile: string;
};

export type TestDatabaseConfig = {
    user: string;
    password: string;
    dbName: string;
};
const defaultTestDatabaseConfig: TestDatabaseConfig = {
    user: 'beetx',
    password: 'let-me-in',
    dbName: 'beetx',
};
const defaultTestDatabasePrismaConfig: TestDatabasePrismaConfig = {
    generateClient: true,
    schemaFile: path.join(__dirname, '../../prisma/schema.prisma'),
};
let postgres: StartedTestContainer;

export async function startTestDb(
    dbConfig: TestDatabaseConfig = defaultTestDatabaseConfig,
): Promise<TestDatabaseContainer> {
    try {
        postgres = await new GenericContainer('postgres')
            .withEnv('POSTGRES_USER', dbConfig.user)
            .withEnv('POSTGRES_PASSWORD', dbConfig.password)
            .withEnv('POSTGRES_DB', dbConfig.dbName)
            .withExposedPorts(5432)
            .start();

        return {
            postgres,
            stop: async () => {
                await postgres.stop();
            },
        };
    } catch (error) {
        console.error('Error spinning up test database', error);
        throw error;
    }
}

export async function createIndividualDatabaseSchemaForTest(
    prismaConfig: TestDatabasePrismaConfig = defaultTestDatabasePrismaConfig,
    dbConfig: TestDatabaseConfig = defaultTestDatabaseConfig,
) {
    const schema = `test_${uuidv4()}`;
    const connectionString = `postgresql://${dbConfig.user}:${
        dbConfig.password
    }@${postgres.getHost()}:${postgres.getMappedPort(5432)}/${dbConfig.dbName}?schema=${schema}`;

    commandSync(`yarn prisma db push --schema ${prismaConfig.schemaFile} --skip-generate`, {
        env: {
            DATABASE_URL: connectionString,
        },
    });
    const prisma = new PrismaClient({
        datasources: {
            db: {
                url: connectionString,
            },
        },
    });

    setPrisma(prisma);
}
