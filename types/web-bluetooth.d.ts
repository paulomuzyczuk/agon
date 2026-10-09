// Minimal ambient Web Bluetooth types — hand-rolled rather than depending on
// @types/web-bluetooth (repo stays dependency-light; see app/globals.css).
// Scoped to exactly what app/record/page.tsx uses: pairing, GATT connect,
// one service/characteristic, and notifications. Extend if a later feature
// needs more of the API surface (e.g. getDevices()/getAvailability()).

interface RequestDeviceOptions {
  filters?: Array<{ services: string[] }>;
  optionalServices?: string[];
  acceptAllDevices?: boolean;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  readonly device: BluetoothDevice;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
}

interface Bluetooth {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}
