#!/usr/bin/env node
import { exportTemplate } from '../lib/export';

const source = process.argv[2] ?? 'cdk.out/customer/PrivateApp.template.json';
const destination = process.argv[3] ?? 'marketplace/template/customer-app.template.json';
try {
  const { sha256, bytes } = exportTemplate(source, destination);
  console.log(`exported ${destination} (${bytes} bytes, sha256 ${sha256})`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
