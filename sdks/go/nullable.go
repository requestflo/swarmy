package swarmy

import (
	"bytes"
	"encoding/json"
)

// Ptr returns a pointer to v. Optional request fields whose zero value is a
// real input (a boolean false, replicas 0) are pointers, so nil leaves them
// out and Ptr(false) sends false:
//
//	UpdateIngressSettingsRequest{Enabled: swarmy.Ptr(false)}
func Ptr[T any](v T) *T { return &v }

// Nullable is an optional request field that is also nullable, which the API
// reads three ways: left out keeps the current value, null clears it, and a
// value sets it. The zero Nullable is left out of the body (its field carries
// `omitzero`); Null sends null; NullableValue sends the value.
//
//	UpdateIngressSettingsRequest{
//		ControllerImage: swarmy.NullableValue("caddy:2.8"), // set
//		Tunnel:          swarmy.Null[swarmy.IngressTunnelInput](), // disconnect
//		// DnsProvider left out: kept as it is
//	}
type Nullable[T any] struct {
	value T
	state nullableState
}

type nullableState uint8

const (
	nullableUnset nullableState = iota
	nullableNull
	nullableValue
)

// NullableValue is a Nullable that sends v.
func NullableValue[T any](v T) Nullable[T] { return Nullable[T]{value: v, state: nullableValue} }

// Null is a Nullable that sends JSON null.
func Null[T any]() Nullable[T] { return Nullable[T]{state: nullableNull} }

// IsZero reports whether the field is unset; encoding/json's omitzero leaves it out.
func (n Nullable[T]) IsZero() bool { return n.state == nullableUnset }

// IsNull reports whether the field is set to null.
func (n Nullable[T]) IsNull() bool { return n.state == nullableNull }

// Get returns the value and whether one is set (false when unset or null).
func (n Nullable[T]) Get() (T, bool) { return n.value, n.state == nullableValue }

// MarshalJSON writes the value, or null when there is none.
func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if n.state != nullableValue {
		return []byte("null"), nil
	}
	return json.Marshal(n.value)
}

// UnmarshalJSON reads null as Null and anything else as a value.
func (n *Nullable[T]) UnmarshalJSON(b []byte) error {
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		*n = Null[T]()
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*n = NullableValue(v)
	return nil
}
