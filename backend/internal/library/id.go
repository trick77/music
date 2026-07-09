package library

import (
	"crypto/rand"
	"encoding/hex"
)

// NewID returns a random 32-character hex identifier.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return hex.EncodeToString(b[:])
}
