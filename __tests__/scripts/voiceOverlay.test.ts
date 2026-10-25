import { readFileSync } from 'fs';
import { join } from 'path';

// MZY-397: transcription runs inside the bot container, so the Linux voice
// overlay must build whisper.cpp and a model into that image, and everything it
// downloads at build time must be pinned and verified.

const root = join(__dirname, '../..');
const dockerfile = readFileSync(
  join(root, 'docker/bot-whisper/Dockerfile'),
  'utf8',
);
const overlay = readFileSync(join(root, 'docker-compose.voice.yml'), 'utf8');

describe('voice overlay', () => {
  it('swaps only the bot service, building from the stock app image', () => {
    expect(overlay).toMatch(/^services:\n {2}bot:\n/m);
    expect(overlay).not.toMatch(/^ {2}app:/m);
    expect(overlay).toContain('agon_base: service:app');
  });

  it('pins whisper.cpp to a full commit sha', () => {
    expect(dockerfile).toMatch(/ARG WHISPER_CPP_COMMIT=[0-9a-f]{40}\b/);
    expect(dockerfile).not.toMatch(/git clone/);
  });

  it('downloads the model from a pinned revision, never a moving ref', () => {
    expect(dockerfile).toMatch(/ARG WHISPER_MODEL_REV=[0-9a-f]{40}\b/);
    expect(dockerfile).not.toContain('resolve/main');
  });

  it('verifies a sha256 for every offered model size and fails on an unknown one', () => {
    for (const size of ['tiny', 'base', 'small', 'medium']) {
      expect(dockerfile).toMatch(new RegExp(`${size}\\) +sha=[0-9a-f]{64} ;;`));
    }
    expect(dockerfile).toContain('sha256sum -c -');
    expect(dockerfile).toMatch(
      /AGON_WHISPER_MODEL must be tiny, base, small or medium/,
    );
  });

  it('turns off ggml native CPU detection on aarch64 only, where it breaks the gcc 12 build', () => {
    // Without it the build fails on ARM hosts ("target specific option mismatch", vfmaq_f16),
    // found when the overlay was first built on Apple Silicon. amd64 keeps native detection.
    expect(dockerfile).toMatch(
      /\[ "\$\(uname -m\)" = "aarch64" \] && native="-DGGML_NATIVE=OFF"/,
    );
    expect(dockerfile).toMatch(/cmake -B build [^\n]*\$native/);
  });

  it('keeps the runtime image non-root', () => {
    const lastUser = [...dockerfile.matchAll(/^USER (\S+)/gm)].pop()?.[1];
    expect(lastUser).toBe('node');
  });
});
