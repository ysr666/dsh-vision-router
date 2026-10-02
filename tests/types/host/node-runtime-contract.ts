import { domainToASCII } from 'node:url'

const runtimeVersion: string = process.version
const canonicalHost: string = domainToASCII('example.com')

void runtimeVersion
void canonicalHost
