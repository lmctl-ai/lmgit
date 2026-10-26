# Third-party notices

lmgit is MIT-licensed original work of Lattice Systems LLC (see `LICENSE`),
built on the material described below.

## git (the version control system)

Source: https://github.com/git/git (vendored under `third_party/git`, pinned
by `git.lock`)

git is licensed under the GNU General Public License version 2. **lmgit does
not link, embed, or copy git code**: the vendored checkout is a read-only
reference, and at runtime lmgit invokes the `git` binary as a separate
process over argv (stdin/stdout), which is independent work under the GPL's
terms. No git source code is included in the lmgit binaries. The full GPL
v2 text is available at https://gnu.org/licenses/old-licenses/gpl-2.0.txt
and in the vendored checkout at `third_party/git/COPYING`.

## lmcode-go

Source: https://github.com/lmctl-ai/lmcode-go (Go SDK, pinned in
`go.mod`/`go.sum`)

MIT licensed; see the lmcode-go repository.
