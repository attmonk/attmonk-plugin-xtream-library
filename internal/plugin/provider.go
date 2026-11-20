package plugin

import "github.com/attmonk/attmonk-plugin-xtream-library/internal/model"

type Descriptor struct {
	SourceID string
	Name     string
}

func ProviderDescriptor() Descriptor {
	return Descriptor{SourceID: model.LiveTVSourceID, Name: "Live TV"}
}
