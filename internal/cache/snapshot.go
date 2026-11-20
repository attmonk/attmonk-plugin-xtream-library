package cache

import "github.com/attmonk/attmonk-plugin-xtream-library/internal/model"

func SnapshotFromCatalog(catalog model.CatalogState) Snapshot {
	return Snapshot{Catalog: catalog, Health: catalog.Health}
}
