import moment from 'moment';
import { graphql } from 'msw';
import { prisma } from '../../prisma/prisma-client';
import { networkConfig } from '../config/network-config';
import {
    createSchemaForTest as createDedicatedSchemaForTest,
    createWeightedPoolFromDefault,
    defaultTokens,
    createRandomSnapshotsForPool,
    createRandomSnapshotsForPoolForTimestamp,
    createUserPoolBalanceSnapshot,
} from '../tests-helper/jest-test-helpers';
import { server } from '../tests-helper/mocks/server';
import { userService } from './user.service';

/*
TEST SETUP:
- Two different weighted pools, one with 30 random snapshots (complete, one spanshot per day) one with only 2 snapshots
- pool1 has also a farm specified
- One user 

*/
const poolId1 = '0x001a';
const poolName1 = 'Test pool 1';
const poolAddress1 = '0x001';
const farmId1 = '0x001a-stake';

const pool2Id = '0x002a';
const poolName2 = 'Test pool 2';
const poolAddress2 = '0x002';

const userAddress = '0x0000000000000000000000000000000000000001';

beforeAll(async () => {
    await createDedicatedSchemaForTest();
    const pool1 = await createWeightedPoolFromDefault(
        {
            id: poolId1,
            name: poolName1,
            address: poolAddress1,
            staking: {
                create: {
                    id: farmId1,
                },
            },
        },
        [defaultTokens.usdc, defaultTokens.wftm, defaultTokens.wbtc, defaultTokens.beets],
    );

    // create 30 snapshotsfor pool1
    await createRandomSnapshotsForPool(pool1.id, pool1.tokens.length, 30);

    // create user
    await prisma.prismaUser.create({
        data: {
            address: userAddress,
        },
    });
}, 60000);

afterEach(async () => {
    server.resetHandlers();
    await prisma.prismaUserPoolBalanceSnapshot.deleteMany({});
});

beforeEach(async () => {});

test('The user requests the user stats for the first time, requesting from snapshot, persiting to db.', async () => {
    /*
    Scenario: 
    - The user requests the user stats for the first time
    - The user joined pool1 three days ago, joined again one day ago, added some to farm and joined another pool one day ago

    Mock data for user-balance-subgraph (important that timestamps are ASC, as this is requested like this form the function under test):
    - Create three snapshots for user
    - First snapshot from three days ago, where he only has 1 bpts from pool1 in his wallet
    - Seconds snapshot from one day ago, where he has 0.5 bpt from pool1 and 1 bpt from pool2 in his wallet and 1 bpt from pool1 in the farm
    - Third snapshot from today, where he has only 1 bpt from pool2 in his wallet 

    Behaviour under test:
    - Snapshot inference that a fourth snapshot is created for missing day two days ago
    - Snapshots are retrieved from subgraph and persisted in DB
    - Only snapshots for requested pool and without inferred snapshot are persisted in DB (three snapshots)
    - Balances are correctly returned and summarized (farmbalance + walletbalance = totalbalance)
    - USD values are correctly calculated based on pool snapshot values
    */
    const today = moment().startOf('day').unix();
    const oneDayInSeconds = 86400;
    const threeDaysAgo = today - 3 * oneDayInSeconds;
    const oneDayAgo = today - 1 * oneDayInSeconds;

    const timestampOfLastReturnedSnapshot = today;

    server.use(
        ...[
            graphql.query('UserBalanceSnapshots', async (req, res, ctx) => {
                const requestJson = await req.json();
                if (requestJson.variables.where.timestamp_gte > timestampOfLastReturnedSnapshot) {
                    return res(
                        ctx.data({
                            snapshots: [],
                        }),
                    );
                }
                // important, sort snapshots ASC
                return res(
                    ctx.data({
                        snapshots: [
                            {
                                id: `${userAddress}-${threeDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: threeDaysAgo,
                                walletTokens: [poolAddress1],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${oneDayAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: oneDayAgo,
                                walletTokens: [poolAddress1, poolAddress2],
                                walletBalances: ['0.5', '1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [farmId1],
                                farmBalances: ['1.0'],
                            },
                            {
                                id: `${userAddress}-${today}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: today,
                                walletTokens: [poolAddress2],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                        ],
                    }),
                );
            }),
        ],
    );

    const snapshotsFromService = await userService.getUserBalanceSnapshotsForPool(userAddress, poolId1, 'THIRTY_DAYS');
    //check if 4th snapshot has been inferred from three present ones
    expect(snapshotsFromService.length).toBe(4);
    const snapshotsFromDb = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
        include: { pool: true },
    });

    // check if the 3 snapshots have been persisted
    expect(snapshotsFromDb.length).toBe(3);

    // check if balances are calculated correctly
    expect(snapshotsFromService[0].walletBalance).toBe('1');
    expect(snapshotsFromService[0].timestamp).toBe(today - 3 * oneDayInSeconds);
    expect(snapshotsFromService[1].walletBalance).toBe('1');
    expect(snapshotsFromService[1].timestamp).toBe(today - 2 * oneDayInSeconds);

    expect(snapshotsFromService[2].walletBalance).toBe('0.5');
    expect(snapshotsFromService[2].farmBalance).toBe('1.0');
    expect(snapshotsFromService[2].totalBalance).toBe('1.5');
    expect(snapshotsFromService[2].timestamp).toBe(today - 1 * oneDayInSeconds);

    expect(snapshotsFromService[3].walletBalance).toBe('0');
    expect(snapshotsFromService[3].timestamp).toBe(today - 0 * oneDayInSeconds);

    const poolSnapshots = await prisma.prismaPoolSnapshot.findMany({
        where: { poolId: poolId1 },
    });

    // check if usd value, percent share of the pool and fees are correctly calculated based on poolsnapshots
    for (const userBalanceSnapshot of snapshotsFromService) {
        let foundPoolSnapshot = false;
        for (const poolSnapshot of poolSnapshots) {
            if (poolSnapshot.timestamp === userBalanceSnapshot.timestamp) {
                expect(userBalanceSnapshot.totalValueUSD).toBe(
                    `${poolSnapshot.sharePrice * parseFloat(userBalanceSnapshot.totalBalance)}`,
                );
                expect(userBalanceSnapshot.percentShare).toBe(
                    parseFloat(userBalanceSnapshot.totalBalance) / poolSnapshot.totalSharesNum,
                );
                expect(userBalanceSnapshot.fees24h).toBe(
                    `${
                        userBalanceSnapshot.percentShare *
                        poolSnapshot.fees24h *
                        (1 - networkConfig.balancer.protocolFeePercent)
                    }`,
                );
                foundPoolSnapshot = true;
            }
        }
        //make sure we have a pool snapshot for each user snapshot
        expect(foundPoolSnapshot).toBe(true);
    }
});

test('user leaves pool and joins pool again', async () => {
    /*
Scenario: 
- The user requests the user stats for the first time
- The user joined pool1 three days ago, left the pool two days ago and joined again one day ago

Mock data for user-balance-subgraph (important that timestamps are ASC, as this is requested like this form the function under test):
- Create three snapshots for user
- First snapshot from three days ago, where he only has 1 bpts from pool1 in his wallet
- Seconds snapshot from two days ago, where he has no balance
- Third snapshot from yesterday, where he has 1 bpt from pool1 in his wallet

Behaviour under test:
- Snapshot inference that he has the same amount today as yesterday
- 0 balance snapshots are correctly returned
*/
    const today = moment().startOf('day').unix();
    const oneDayInSeconds = 86400;
    const threeDaysAgo = today - 3 * oneDayInSeconds;
    const twoDaysAgo = today - 2 * oneDayInSeconds;
    const oneDayAgo = today - 1 * oneDayInSeconds;

    const timestampOfLastReturnedSnapshot = oneDayAgo;

    server.use(
        ...[
            graphql.query('UserBalanceSnapshots', async (req, res, ctx) => {
                const requestJson = await req.json();
                if (requestJson.variables.where.timestamp_gte > timestampOfLastReturnedSnapshot) {
                    return res(
                        ctx.data({
                            snapshots: [],
                        }),
                    );
                }
                // important, sort snapshots ASC
                return res(
                    ctx.data({
                        snapshots: [
                            {
                                id: `${userAddress}-${threeDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: threeDaysAgo,
                                walletTokens: [poolAddress1],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${twoDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: twoDaysAgo,
                                walletTokens: [],
                                walletBalances: [],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${oneDayAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: oneDayAgo,
                                walletTokens: [poolAddress1],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                        ],
                    }),
                );
            }),
        ],
    );

    const snapshotsFromService = await userService.getUserBalanceSnapshotsForPool(userAddress, poolId1, 'THIRTY_DAYS');
    //check if 4th snapshot has been inferred from three present ones
    expect(snapshotsFromService.length).toBe(4);
    const snapshotsFromDb = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
        include: { pool: true },
    });

    // check if the 3 snapshots have been persisted
    expect(snapshotsFromDb.length).toBe(3);

    // check if balances are calculated correctly
    expect(snapshotsFromService[0].timestamp).toBe(threeDaysAgo);
    expect(snapshotsFromService[0].walletBalance).toBe('1');
    expect(snapshotsFromService[1].timestamp).toBe(twoDaysAgo);
    expect(snapshotsFromService[1].walletBalance).toBe('0');
    expect(snapshotsFromService[1].totalValueUSD).toBe('0');
    expect(snapshotsFromService[1].fees24h).toBe('0');
    expect(snapshotsFromService[1].percentShare).toBe(0);

    expect(snapshotsFromService[2].timestamp).toBe(oneDayAgo);
    expect(snapshotsFromService[2].walletBalance).toBe('1');

    expect(snapshotsFromService[3].timestamp).toBe(today);
    expect(snapshotsFromService[3].walletBalance).toBe('1');

    const poolSnapshots = await prisma.prismaPoolSnapshot.findMany({
        where: { poolId: poolId1 },
    });

    // check if usd value, percent share of the pool and fees are correctly calculated based on poolsnapshots
    for (const userBalanceSnapshot of snapshotsFromService) {
        let foundPoolSnapshot = false;
        for (const poolSnapshot of poolSnapshots) {
            if (poolSnapshot.timestamp === userBalanceSnapshot.timestamp) {
                expect(userBalanceSnapshot.totalValueUSD).toBe(
                    `${poolSnapshot.sharePrice * parseFloat(userBalanceSnapshot.totalBalance)}`,
                );
                expect(userBalanceSnapshot.percentShare).toBe(
                    parseFloat(userBalanceSnapshot.totalBalance) / poolSnapshot.totalSharesNum,
                );
                expect(userBalanceSnapshot.fees24h).toBe(
                    `${
                        userBalanceSnapshot.percentShare *
                        poolSnapshot.fees24h *
                        (1 - networkConfig.balancer.protocolFeePercent)
                    }`,
                );
                foundPoolSnapshot = true;
            }
        }
        //make sure we have a pool snapshot for each user snapshot
        expect(foundPoolSnapshot).toBe(true);
    }
});

test('user left pool, no 0 snapshots returned', async () => {
    /*
Scenario: 
- The user requests the user stats for the first time
- The user joined pool1 three days ago, left the pool two days ago

Mock data for user-balance-subgraph (important that timestamps are ASC, as this is requested like this form the function under test):
- Create two snapshots for user
- First snapshot from three days ago, where he only has 1 bpts from pool1 in his wallet
- Seconds snapshot from two days ago, where he has no balance

Behaviour under test:
- That once he leaves, those 0 balance snapshots are neither persisted nor returned
*/
    const today = moment().startOf('day').unix();
    const oneDayInSeconds = 86400;
    const threeDaysAgo = today - 3 * oneDayInSeconds;
    const twoDaysAgo = today - 2 * oneDayInSeconds;
    const timestampOfLastReturnedSnapshot = twoDaysAgo;

    server.use(
        ...[
            graphql.query('UserBalanceSnapshots', async (req, res, ctx) => {
                const requestJson = await req.json();
                if (requestJson.variables.where.timestamp_gte > timestampOfLastReturnedSnapshot) {
                    return res(
                        ctx.data({
                            snapshots: [],
                        }),
                    );
                }
                // important, sort snapshots ASC
                return res(
                    ctx.data({
                        snapshots: [
                            {
                                id: `${userAddress}-${threeDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: threeDaysAgo,
                                walletTokens: [poolAddress1],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${twoDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: twoDaysAgo,
                                walletTokens: [],
                                walletBalances: [],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                        ],
                    }),
                );
            }),
        ],
    );

    const snapshotsFromService = await userService.getUserBalanceSnapshotsForPool(userAddress, poolId1, 'THIRTY_DAYS');
    //check if 4th snapshot has been inferred from three present ones
    expect(snapshotsFromService.length).toBe(2);
    const snapshotsFromDb = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
        include: { pool: true },
    });

    // check if the 3 snapshots have been persisted
    expect(snapshotsFromDb.length).toBe(2);

    // check if balances are calculated correctly
    expect(snapshotsFromService[0].timestamp).toBe(threeDaysAgo);
    expect(snapshotsFromService[0].walletBalance).toBe('1');
    expect(snapshotsFromService[1].timestamp).toBe(twoDaysAgo);
    expect(snapshotsFromService[1].walletBalance).toBe('0');
    expect(snapshotsFromService[1].totalValueUSD).toBe('0');
    expect(snapshotsFromService[1].fees24h).toBe('0');
    expect(snapshotsFromService[1].percentShare).toBe(0);
});

test('0 $ value user snapshots if there is no pool snapshot', async () => {
    /*
    Scenario: 
    - The user requests the user stats for the first time
    - The user joined pool2 three days ago and is still in the pool
    - Poolsnapshots are only available for two days, therefore only two $ value > 0 snapshots are present
    - Adding a "delayed" poolSnapshot which changes the value of the user snapshot

    Mock data for user-balance-subgraph (important that timestamps are ASC, as this is requested like this form the function under test):
    - Create one snapshots for user
    - First snapshot from three days ago, where he has 1 bpts from pool1 in his wallet
    - create two pool snapshots for pool2 for three days ago and two days ago
   

    Behaviour under test:
    - Pool2 has only two snapshots for three days ago and two days ago. 
    We should have 4 usersnapshots but only the ones from three and two days ago should have $ values.
    - We then create another pool snapshot for today
    - We should now have 3 usersnapshots with $ values
    */

    const today = moment().startOf('day').unix();
    const oneDayInSeconds = 86400;
    const threeDaysAgo = today - 3 * oneDayInSeconds;
    const twoDaysAgo = today - 2 * oneDayInSeconds;
    const oneDayAgo = today - 1 * oneDayInSeconds;

    const timestampOfLastReturnedSnapshot = threeDaysAgo;

    // setup mock data in DB
    const pool2 = await createWeightedPoolFromDefault(
        {
            id: pool2Id,
            name: poolName2,
            address: poolAddress2,
        },
        [defaultTokens.usdc, defaultTokens.beets],
    );
    await createRandomSnapshotsForPoolForTimestamp(pool2.id, pool2.tokens.length, threeDaysAgo);
    await createRandomSnapshotsForPoolForTimestamp(pool2.id, pool2.tokens.length, twoDaysAgo);

    server.use(
        ...[
            graphql.query('UserBalanceSnapshots', async (req, res, ctx) => {
                const requestJson = await req.json();
                if (requestJson.variables.where.timestamp_gte > timestampOfLastReturnedSnapshot) {
                    return res(
                        ctx.data({
                            snapshots: [],
                        }),
                    );
                }
                // important, sort snapshots ASC
                return res(
                    ctx.data({
                        snapshots: [
                            {
                                id: `${userAddress}-${threeDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: threeDaysAgo,
                                walletTokens: [pool2.address],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                        ],
                    }),
                );
            }),
        ],
    );

    const snapshotsFromService = await userService.getUserBalanceSnapshotsForPool(userAddress, pool2Id, 'THIRTY_DAYS');
    // should get all 4 snapshots
    expect(snapshotsFromService.length).toBe(4);
    const snapshotsFromDb = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
        include: { pool: true },
    });

    // check if the 1 snapshots have been persisted (others are inferred on query)
    expect(snapshotsFromDb.length).toBe(1);

    // check if balances are calculated correctly
    expect(snapshotsFromService[0].timestamp).toBe(threeDaysAgo);
    expect(snapshotsFromService[0].walletBalance).toBe('1');
    expect(parseFloat(snapshotsFromService[0].totalValueUSD)).toBeGreaterThan(0);
    expect(snapshotsFromService[1].timestamp).toBe(twoDaysAgo);
    expect(snapshotsFromService[1].walletBalance).toBe('1');
    expect(parseFloat(snapshotsFromService[1].totalValueUSD)).toBeGreaterThan(0);

    expect(snapshotsFromService[2].timestamp).toBe(oneDayAgo);
    expect(snapshotsFromService[2].walletBalance).toBe('1');
    expect(parseFloat(snapshotsFromService[2].totalValueUSD)).toBe(0);

    expect(snapshotsFromService[3].timestamp).toBe(today);
    expect(snapshotsFromService[3].walletBalance).toBe('1');
    expect(parseFloat(snapshotsFromService[3].totalValueUSD)).toBe(0);

    await createRandomSnapshotsForPoolForTimestamp(pool2.id, pool2.tokens.length, today);

    const snapshotsAfterAdditionalPoolSnapshot = await userService.getUserBalanceSnapshotsForPool(
        userAddress,
        pool2Id,
        'THIRTY_DAYS',
    );
    //expect still the same results here as above
    expect(snapshotsFromService[0].timestamp).toBe(threeDaysAgo);
    expect(snapshotsFromService[0].walletBalance).toBe('1');
    expect(parseFloat(snapshotsFromService[0].totalValueUSD)).toBeGreaterThan(0);
    expect(snapshotsFromService[1].timestamp).toBe(twoDaysAgo);
    expect(snapshotsFromService[1].walletBalance).toBe('1');
    expect(parseFloat(snapshotsFromService[1].totalValueUSD)).toBeGreaterThan(0);

    expect(snapshotsFromService[2].timestamp).toBe(oneDayAgo);
    expect(snapshotsFromService[2].walletBalance).toBe('1');
    expect(parseFloat(snapshotsFromService[2].totalValueUSD)).toBe(0);

    // expecting a >0 value here since now a poolsnapshot was created
    expect(snapshotsAfterAdditionalPoolSnapshot[3].timestamp).toBe(today);
    expect(snapshotsAfterAdditionalPoolSnapshot[3].walletBalance).toBe('1');
    expect(parseFloat(snapshotsAfterAdditionalPoolSnapshot[3].totalValueUSD)).toBeGreaterThan(0);
});

test('Persisted user snapshots are synced', async () => {
    /*
    Scenario:
    - The user has once requested the user stats for pool1
    - Since one user snapshot is in the database, the userBalanceSync should query the subgraph and sync all missing snapshots until now

    Mock data for user-balance-subgraph (important that timestamps are ASC, as this is requested like this form the function under test):
    - Create three snapshots for user
    - First snapshot from three days ago, where he only has 1 bpts from pool1 in his wallet
    - Seconds snapshot from one day ago, where he has 0.5 bpt from pool1 and 1 bpt from pool2 in his wallet and 1 bpt from pool1 in the farm
    - Third snapshot from today, where he has only 1 bpt from pool2 in his wallet

    Mock data in data base:
    - Create one userbalance snapshot for three days ago for the user and pool1

    Behaviour under test:
    - The oldest user snapshot from three days ago for pool1 is already persisted in the db from a previous run (here mocked)
    - Sync finds that snapshot and will sync ALL from the latest until today
    - Sync will only sync snapshots of pool1, not of pool2
    */

    const today = moment().startOf('day').unix();
    const oneDayInSeconds = 86400;
    const threeDaysAgo = today - 3 * oneDayInSeconds;
    const twoDaysAgo = today - 2 * oneDayInSeconds;
    const oneDayAgo = today - 1 * oneDayInSeconds;
    const newestSnapshotTimestamp = today;

    await createUserPoolBalanceSnapshot({
        id: `${poolId1}-${userAddress}-${threeDaysAgo}`,
        timestamp: threeDaysAgo,
        user: { connect: { address: userAddress } },
        pool: {
            connect: {
                id: poolId1,
            },
        },
        poolToken: poolAddress1,
        walletBalance: '1',
        farmBalance: '0',
        gaugeBalance: '0',
        totalBalance: '1',
    });

    server.use(
        ...[
            graphql.query('UserBalanceSnapshots', async (req, res, ctx) => {
                const requestJson = await req.json();
                if (requestJson.variables.where.timestamp_gte > newestSnapshotTimestamp) {
                    return res(
                        ctx.data({
                            snapshots: [],
                        }),
                    );
                }
                // important, sort snapshots ASC
                return res(
                    ctx.data({
                        snapshots: [
                            {
                                id: `${userAddress}-${threeDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: threeDaysAgo,
                                walletTokens: [poolAddress1],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${oneDayAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: oneDayAgo,
                                walletTokens: [poolAddress1, poolAddress2],
                                walletBalances: ['0.5', '1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [farmId1],
                                farmBalances: ['1.0'],
                            },
                            {
                                id: `${userAddress}-${today}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: today,
                                walletTokens: [poolAddress1, poolAddress2],
                                walletBalances: ['0', '1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                        ],
                    }),
                );
            }),
        ],
    );

    // before the sync is called, this should only return one snapshot that was manually added to the DB in this test
    const snapshotsInDbBeforeSync = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
    });
    expect(snapshotsInDbBeforeSync.length).toBe(1);

    // sync
    await userService.syncUserBalanceSnapshots();

    const snapshotsFromDb = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
    });

    // check if snapshots have been persisted (only three, one is inferred at query)
    expect(snapshotsFromDb.length).toBe(3);

    // after the sync, the all 4 snapshots should be present
    const snapshotsAfterSync = await userService.getUserBalanceSnapshotsForPool(userAddress, poolId1, 'THIRTY_DAYS');
    expect(snapshotsAfterSync.length).toBe(4);

    // check if balances are calculated correctly
    expect(snapshotsAfterSync[0].walletBalance).toBe('1');
    expect(snapshotsAfterSync[0].timestamp).toBe(threeDaysAgo);
    expect(snapshotsAfterSync[1].walletBalance).toBe('1');
    expect(snapshotsAfterSync[1].timestamp).toBe(twoDaysAgo);

    expect(snapshotsAfterSync[2].walletBalance).toBe('0.5');
    expect(snapshotsAfterSync[2].farmBalance).toBe('1.0');
    expect(snapshotsAfterSync[2].totalBalance).toBe('1.5');
    expect(snapshotsAfterSync[2].timestamp).toBe(oneDayAgo);

    expect(snapshotsAfterSync[3].walletBalance).toBe('0');
    expect(snapshotsAfterSync[3].timestamp).toBe(today);

    const poolSnapshots = await prisma.prismaPoolSnapshot.findMany({
        where: { poolId: poolId1 },
    });

    // check if usd value, percent share of the pool and fees are correctly calculated based on poolsnapshots
    for (const userBalanceSnapshot of snapshotsAfterSync) {
        let foundPoolSnapshot = false;
        for (const poolSnapshot of poolSnapshots) {
            if (poolSnapshot.timestamp === userBalanceSnapshot.timestamp) {
                expect(userBalanceSnapshot.totalValueUSD).toBe(
                    `${poolSnapshot.sharePrice * parseFloat(userBalanceSnapshot.totalBalance)}`,
                );
                expect(userBalanceSnapshot.percentShare).toBe(
                    parseFloat(userBalanceSnapshot.totalBalance) / poolSnapshot.totalSharesNum,
                );
                expect(userBalanceSnapshot.fees24h).toBe(
                    `${
                        userBalanceSnapshot.percentShare *
                        poolSnapshot.fees24h *
                        (1 - networkConfig.balancer.protocolFeePercent)
                    }`,
                );
                foundPoolSnapshot = true;
            }
        }
        //make sure we have a pool snapshot for each user snapshot
        expect(foundPoolSnapshot).toBe(true);
    }
});

test('Sync and get pool with gaps', async () => {
    /*
    Scenario:
    - The user has once requested the user stats for pool1
    - Since one user snapshot is in the database, the userBalanceSync should query the subgraph and sync all missing snapshots until now
    - user joined pool seven days ago, left again five days ago, joined pool and farm again three days ago, left both two days ago

    Mock data for user-balance-subgraph (important that timestamps are ASC, as this is requested like this form the function under test):
    - Create five snapshots for user representing the above scenario

    Mock data in data base:
    - Create one userbalance snapshot for seven days ago for the user and pool1

    Behaviour under test:
    - The oldest user snapshot from seven days ago for pool1 is already persisted in the db from a previous run (here mocked)
    - Sync finds that snapshot and will sync ALL from the latest until today
    - Sync will not persist the 0 balance gap from four days ago and one day ago and today
    - Sync will not persist >0 balance gap from six days ago
    */

    const today = moment().startOf('day').unix();
    const oneDayInSeconds = 86400;
    const sevenDaysAgo = today - 7 * oneDayInSeconds;
    const sixDaysAgo = today - 6 * oneDayInSeconds;
    const fiveDaysAgo = today - 5 * oneDayInSeconds;
    const fourDaysAgo = today - 4 * oneDayInSeconds;
    const threeDaysAgo = today - 3 * oneDayInSeconds;
    const twoDaysAgo = today - 2 * oneDayInSeconds;
    const oneDayAgo = today - 1 * oneDayInSeconds;
    const newestSnapshotTimestamp = oneDayAgo;

    await createUserPoolBalanceSnapshot({
        id: `${poolId1}-${userAddress}-${sevenDaysAgo}`,
        timestamp: sevenDaysAgo,
        user: { connect: { address: userAddress } },
        pool: {
            connect: {
                id: poolId1,
            },
        },
        poolToken: poolAddress1,
        walletBalance: '1',
        farmBalance: '0',
        gaugeBalance: '0',
        totalBalance: '1',
    });

    server.use(
        ...[
            graphql.query('UserBalanceSnapshots', async (req, res, ctx) => {
                const requestJson = await req.json();
                if (requestJson.variables.where.timestamp_gte > newestSnapshotTimestamp) {
                    return res(
                        ctx.data({
                            snapshots: [],
                        }),
                    );
                }
                // important, sort snapshots ASC
                return res(
                    ctx.data({
                        snapshots: [
                            {
                                id: `${userAddress}-${sevenDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: sevenDaysAgo,
                                walletTokens: [poolAddress1],
                                walletBalances: ['1'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${fiveDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: fiveDaysAgo,
                                walletTokens: [],
                                walletBalances: [],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${threeDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: threeDaysAgo,
                                walletTokens: [poolAddress1],
                                walletBalances: ['0.5'],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [farmId1],
                                farmBalances: ['1'],
                            },
                            {
                                id: `${userAddress}-${twoDaysAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: twoDaysAgo,
                                walletTokens: [],
                                walletBalances: [],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                            {
                                id: `${userAddress}-${oneDayAgo}`,
                                user: {
                                    id: userAddress,
                                },
                                timestamp: oneDayAgo,
                                walletTokens: [],
                                walletBalances: [],
                                gauges: [],
                                gaugeBalances: [],
                                farms: [],
                                farmBalances: [],
                            },
                        ],
                    }),
                );
            }),
        ],
    );

    // before the sync is called, this should only return one snapshot that was manually added to the DB in this test
    const snapshotsInDbBeforeSync = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
    });
    expect(snapshotsInDbBeforeSync.length).toBe(1);

    // sync
    await userService.syncUserBalanceSnapshots();

    const snapshotsFromDb = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
    });

    // check if snapshots have been persisted (only four, rest is inferred at query or consecutive 0 balance)
    expect(snapshotsFromDb.length).toBe(4);

    // after the sync, 5 snapshots should be present.
    //Sevendaysago, sixdaysago (inferred), fivedaysago (0 balance), fourdays ago (0 balance), threedaysago and twodaysago (0 balance)
    const snapshotsAfterSync = await userService.getUserBalanceSnapshotsForPool(userAddress, poolId1, 'THIRTY_DAYS');
    expect(snapshotsAfterSync.length).toBe(6);

    const snapshotsFromDbAfterGet = await prisma.prismaUserPoolBalanceSnapshot.findMany({
        where: {
            userAddress: userAddress,
        },
    });

    // check if snapshots are still 4 on db (no new added because of get)
    expect(snapshotsFromDbAfterGet.length).toBe(4);

    // check if balances are calculated correctly
    expect(snapshotsAfterSync[0].timestamp).toBe(sevenDaysAgo);
    expect(snapshotsAfterSync[0].walletBalance).toBe('1');
    expect(snapshotsAfterSync[0].totalBalance).toBe('1.0');
    expect(snapshotsAfterSync[1].timestamp).toBe(sixDaysAgo);
    expect(snapshotsAfterSync[1].walletBalance).toBe('1');
    expect(snapshotsAfterSync[1].totalBalance).toBe('1.0');

    expect(snapshotsAfterSync[2].timestamp).toBe(fiveDaysAgo);
    expect(snapshotsAfterSync[2].walletBalance).toBe('0');
    expect(snapshotsAfterSync[2].totalBalance).toBe('0');

    expect(snapshotsAfterSync[3].timestamp).toBe(fourDaysAgo);
    expect(snapshotsAfterSync[3].walletBalance).toBe('0');
    expect(snapshotsAfterSync[3].farmBalance).toBe('0');
    expect(snapshotsAfterSync[3].totalBalance).toBe('0');

    expect(snapshotsAfterSync[4].timestamp).toBe(threeDaysAgo);
    expect(snapshotsAfterSync[4].walletBalance).toBe('0.5');
    expect(snapshotsAfterSync[4].farmBalance).toBe('1');
    expect(snapshotsAfterSync[4].totalBalance).toBe('1.5');

    expect(snapshotsAfterSync[5].timestamp).toBe(twoDaysAgo);
    expect(snapshotsAfterSync[5].walletBalance).toBe('0');
    expect(snapshotsAfterSync[5].totalBalance).toBe('0');

    const poolSnapshots = await prisma.prismaPoolSnapshot.findMany({
        where: { poolId: poolId1 },
    });

    // check if usd value, percent share of the pool and fees are correctly calculated based on poolsnapshots
    for (const userBalanceSnapshot of snapshotsAfterSync) {
        let foundPoolSnapshot = false;
        for (const poolSnapshot of poolSnapshots) {
            if (poolSnapshot.timestamp === userBalanceSnapshot.timestamp) {
                expect(userBalanceSnapshot.totalValueUSD).toBe(
                    `${poolSnapshot.sharePrice * parseFloat(userBalanceSnapshot.totalBalance)}`,
                );
                expect(userBalanceSnapshot.percentShare).toBe(
                    parseFloat(userBalanceSnapshot.totalBalance) / poolSnapshot.totalSharesNum,
                );
                expect(userBalanceSnapshot.fees24h).toBe(
                    `${
                        userBalanceSnapshot.percentShare *
                        poolSnapshot.fees24h *
                        (1 - networkConfig.balancer.protocolFeePercent)
                    }`,
                );
                foundPoolSnapshot = true;
            }
        }
        //make sure we have a pool snapshot for each user snapshot
        expect(foundPoolSnapshot).toBe(true);
    }
});

test('Sync pool with gaps', async () => {});

// Clean up after the tests are finished.
afterAll(async () => {
    await prisma.$disconnect();
});
