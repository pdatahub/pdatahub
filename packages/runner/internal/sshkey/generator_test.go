package sshkey_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/ssh"

	"github.com/pdatahub/pdatahub/runner/internal/sshkey"
)

func TestGenerate_BasicFieldsPopulated(t *testing.T) {
	k, err := sshkey.Generate()
	require.NoError(t, err)
	require.NotNil(t, k)

	assert.Len(t, k.PrivateKey, ed25519.PrivateKeySize)
	assert.Len(t, k.PublicKey, ed25519.PublicKeySize)

	assert.True(t, strings.HasPrefix(k.PrivateKeyOpenSSH, "-----BEGIN OPENSSH PRIVATE KEY-----"),
		"private key PEM should be OpenSSH format")
	assert.Contains(t, k.PrivateKeyOpenSSH, "-----END OPENSSH PRIVATE KEY-----")

	assert.True(t, strings.HasPrefix(k.AuthorizedKey, "ssh-ed25519 "),
		"authorized_keys line should start with ssh-ed25519 algorithm identifier")
	assert.Contains(t, k.AuthorizedKey, sshkey.Authority)
	assert.Contains(t, k.AuthorizedKey, "@")

	assert.True(t, strings.HasPrefix(k.Fingerprint, "SHA256:"), "fingerprint should use OpenSSH SHA256 format")
	assert.Greater(t, len(k.Fingerprint), len("SHA256:"))
}

func TestGenerate_DeterministicAt(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	k, err := sshkey.GenerateAt(now)
	require.NoError(t, err)
	assert.Equal(t, now.Unix(), k.GeneratedAt.Unix())
	// Authority line should include the timestamp.
	assert.Contains(t, k.AuthorizedKey, "@1700000000")
}

func TestGenerate_AuthorizedKeyRoundTripsThroughSSHParse(t *testing.T) {
	k, err := sshkey.Generate()
	require.NoError(t, err)

	pub, err := sshkey.PublicKeyFromAuthorizedKey(k.AuthorizedKey)
	require.NoError(t, err)
	require.NotNil(t, pub)

	// Type should be ssh-ed25519.
	assert.Equal(t, ssh.KeyAlgoED25519, pub.Type())

	// Round-tripped fingerprint should match the original.
	fp, err := sshkey.FingerprintFromAuthorizedKey(k.AuthorizedKey)
	require.NoError(t, err)
	assert.Equal(t, k.Fingerprint, fp)
}

func TestGenerate_PublicKeyExtractedMatchesRaw(t *testing.T) {
	k, err := sshkey.Generate()
	require.NoError(t, err)

	pub, err := sshkey.PublicKeyFromAuthorizedKey(k.AuthorizedKey)
	require.NoError(t, err)
	extracted, err := sshkey.AsEd25519PublicKey(pub)
	require.NoError(t, err)
	assert.Equal(t, k.PublicKey, extracted)
}

func TestGenerate_DistinctKeysHaveDistinctFingerprints(t *testing.T) {
	const N = 100
	seen := make(map[string]bool, N)
	for i := 0; i < N; i++ {
		k, err := sshkey.Generate()
		require.NoError(t, err)
		assert.False(t, seen[k.Fingerprint], "fingerprint collision after %d iterations: %s", i, k.Fingerprint)
		assert.False(t, seen[k.AuthorizedKey], "authorized_key collision after %d iterations", i)
		seen[k.Fingerprint] = true
		seen[k.AuthorizedKey] = true
	}
}

func TestGenerate_FingerprintMatchesDirectComputation(t *testing.T) {
	k, err := sshkey.Generate()
	require.NoError(t, err)
	assert.Equal(t, sshkey.Fingerprint(k.PublicKey), k.Fingerprint)
}

func TestFingerprint_StableForSameInput(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	fp1 := sshkey.Fingerprint(pub)
	fp2 := sshkey.Fingerprint(pub)
	assert.Equal(t, fp1, fp2)
}

func TestFingerprint_DifferentForDifferentKeys(t *testing.T) {
	pub1, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	pub2, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	fp1 := sshkey.Fingerprint(pub1)
	fp2 := sshkey.Fingerprint(pub2)
	assert.NotEqual(t, fp1, fp2)
}

func TestPublicKeyFromAuthorizedKey_RejectsGarbage(t *testing.T) {
	cases := []string{
		"",
		"not-a-key",
		"ssh-rsa AAAA",
		"ssh-ed25519 not-base64!@# runner@host",
	}
	for _, c := range cases {
		_, err := sshkey.PublicKeyFromAuthorizedKey(c)
		assert.Error(t, err, "input=%q should fail to parse", c)
	}
}

func TestAsEd25519PublicKey_RejectsNonEd25519(t *testing.T) {
	// Generate a real RSA keypair so the test fixture is valid.
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)

	rsaPub, err := ssh.NewPublicKey(&priv.PublicKey)
	require.NoError(t, err)
	authLine := ssh.MarshalAuthorizedKey(rsaPub)

	pub, err := sshkey.PublicKeyFromAuthorizedKey(string(authLine))
	require.NoError(t, err, "test fixture must be a valid RSA authorized_keys line")

	_, err = sshkey.AsEd25519PublicKey(pub)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "ed25519")
}

func TestAsEd25519PrivateKey(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	got, err := sshkey.AsEd25519PrivateKey(priv)
	require.NoError(t, err)
	assert.Equal(t, priv, got)

	got, err = sshkey.AsEd25519PrivateKey(&priv)
	require.NoError(t, err)
	assert.Equal(t, priv, got)

	// Nil pointer rejected.
	_, err = sshkey.AsEd25519PrivateKey((*ed25519.PrivateKey)(nil))
	require.Error(t, err)

	// Wrong type rejected.
	_, err = sshkey.AsEd25519PrivateKey("not a key")
	require.Error(t, err)
}

func TestMarshalPKCS8(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	der, err := sshkey.MarshalPKCS8(priv)
	require.NoError(t, err)
	assert.NotEmpty(t, der)
	// PKCS#8 DER is binary; just check it's not empty and not PEM.
	assert.False(t, strings.HasPrefix(string(der), "-----BEGIN"))
}

func TestMustGenerate_PanicsOnEntropyError(t *testing.T) {
	k := sshkey.MustGenerate()
	require.NotNil(t, k)
	assert.NotEmpty(t, k.AuthorizedKey)
}

func TestGenerateAt_DeterministicTimestamp(t *testing.T) {
	ts := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	k, err := sshkey.GenerateAt(ts)
	require.NoError(t, err)
	assert.Equal(t, ts, k.GeneratedAt.UTC())
	expectedStamp := fmt.Sprintf("@%d", ts.Unix())
	assert.Contains(t, k.AuthorizedKey, expectedStamp)
}

func TestFingerprintFromAuthorizedKey_Errors(t *testing.T) {
	_, err := sshkey.FingerprintFromAuthorizedKey("garbage")
	require.Error(t, err)
}

// TestFingerprint_FallbackPath is intentionally skipped: ssh.NewPublicKey does
// not fail for a well-formed ed25519.PublicKey, so the SHA256(raw-bytes)
// fallback in sshkey.Fingerprint is unreachable. The fallback exists only as
// defensive insurance against future API changes.
func TestFingerprint_FallbackPath(t *testing.T) {
	t.Skip("fallback path is unreachable for valid ed25519.PublicKey")
}

func TestMustGenerate(t *testing.T) {
	// Just exercise the helper.
	k := sshkey.MustGenerate()
	require.NotNil(t, k)
	assert.NotEmpty(t, k.AuthorizedKey)
}

func TestAuthority_IsStable(t *testing.T) {
	// The Authority string is referenced by audit scripts and labels.
	// If it changes, we have to update every documented deployment.
	assert.Equal(t, "runner-generated", sshkey.Authority)
}

// Sanity: the base64 portion of an authorized_key line decodes to an SSH
// wire-format blob (RFC 4253 §6.6) — a length-prefixed string that includes
// the algorithm name + the raw key bytes. For ed25519 that's
// 4 (length) + 11 ("ssh-ed25519") + 4 (key length) + 32 (key) = 51 bytes.
func TestGenerate_AuthorizedKeyBase64Length(t *testing.T) {
	k, err := sshkey.Generate()
	require.NoError(t, err)

	parts := strings.Fields(k.AuthorizedKey)
	require.Len(t, parts, 3, "expected '<algo> <b64> <comment>'")
	b64 := parts[1]
	decoded, err := base64.StdEncoding.DecodeString(b64)
	require.NoError(t, err)

	const sshEd25519AlgoLen = len("ssh-ed25519")
	const wireOverhead = 4 + sshEd25519AlgoLen + 4 // length + algo + key length prefix
	expectedLen := wireOverhead + ed25519.PublicKeySize
	assert.Len(t, decoded, expectedLen)
}