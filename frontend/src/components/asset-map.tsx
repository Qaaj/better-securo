import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContainer, Marker, TileLayer } from 'react-leaflet'

// A plain CSS pin, so the map needs no marker image files.
const pin = L.divIcon({
  className: '',
  html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#6366f1;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);transform:rotate(-45deg)"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
})

/** An OpenStreetMap map centred on one point. Tiles are loaded from OpenStreetMap while it is shown. */
export function AssetMap({ latitude, longitude, zoom = 15 }: { latitude: number; longitude: number; zoom?: number }) {
  return (
    <MapContainer
      key={`${latitude},${longitude}`}
      center={[latitude, longitude]}
      zoom={zoom}
      scrollWheelZoom={false}
      className="h-72 w-full rounded-lg z-0"
    >
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Marker position={[latitude, longitude]} icon={pin} />
    </MapContainer>
  )
}

export default AssetMap
