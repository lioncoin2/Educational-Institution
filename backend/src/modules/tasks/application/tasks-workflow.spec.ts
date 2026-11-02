import { describeTasksContract } from '../../../../test/support/tasks-contract-suite';
import { inMemoryTasksPorts } from '../../../../test/support/tasks-harness';

describeTasksContract('in memory', async () => inMemoryTasksPorts());
