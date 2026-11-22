import { fileURLToPath } from 'node:url';

/** The repo's committed fixtures (CONTENT_DIR=./fixtures), wherever the tests are run from. */
export const FIXTURES = fileURLToPath(new URL('../../../fixtures', import.meta.url));
