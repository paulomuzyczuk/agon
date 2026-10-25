import { readFileSync } from 'fs';
import { join } from 'path';

// MZY-398 / MZY-399: a machine that already runs Ollama or serves port 8080
// must be able to move the published ports without editing the compose file,
// and a failed optional service must not share a profile with the other one.

const compose = readFileSync(join(__dirname, '../../docker-compose.yml'), 'utf8');

/** Text of one top-level service block (from `  name:` to the next `  other:` or a top-level key). */
function service(name: string): string {
  const m = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|^\\S)`, 'm'));
  const body = m?.[1];
  if (body === undefined) throw new Error(`docker-compose.yml: service "${name}" not found`);
  return body;
}

describe('docker-compose.yml optional services', () => {
  it('publishes ollama on a host port that OLLAMA_HOST_PORT can move', () => {
    expect(service('ollama')).toContain("'${OLLAMA_HOST_PORT:-11434}:11434'");
  });

  it('publishes ors-app on a host port that ORS_HOST_PORT can move', () => {
    expect(service('ors-app')).toContain("'${ORS_HOST_PORT:-8080}:8082'");
  });

  it('keeps ollama and ors-app in different profiles', () => {
    const profile = (s: string) => s.match(/profiles: \['([^']+)'\]/)?.[1];
    const [o, r] = [profile(service('ollama')), profile(service('ors-app'))];
    expect(o).toBeDefined();
    expect(r).toBeDefined();
    expect(o).not.toBe(r);
  });
});
