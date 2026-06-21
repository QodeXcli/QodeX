/**
 * Vitest global setup — isolate the suite from the developer's personal git config.
 *
 * Several tests spawn real `git` in throwaway temp repos. They set user.name /
 * user.email / commit.gpgsign LOCALLY, but git still READS the global
 * ~/.gitconfig — and a machine configured for SSH commit signing
 * (`gpg.format = ssh`, `commit.gpgsign = true`) makes `git commit` fail on older
 * git with "unsupported value for gpg.format: ssh", which has nothing to do with
 * QodeX. Pointing GIT_CONFIG_GLOBAL/SYSTEM at /dev/null makes git ignore the
 * machine config entirely, so the tests depend only on what they set locally.
 */
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
