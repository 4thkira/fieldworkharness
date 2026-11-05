import process from 'node:process';
import { prepareDependencies } from './prepare-dependencies.mjs';

try { await prepareDependencies(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fieldwork could not prepare its dependencies: ${message}`);
  process.exitCode = 1;
}
