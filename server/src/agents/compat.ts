export type PackageSize = 'small' | 'medium' | 'large';
export type VehicleType = 'bike' | 'car' | 'van' | 'truck';

export const sizeRank: Record<PackageSize, number> = { small: 1, medium: 2, large: 3 };
export const vehicleMaxSize: Record<VehicleType, PackageSize> = { bike: 'small', car: 'medium', van: 'large', truck: 'large' };

export function vehicleCanCarry(vehicle: VehicleType, driverMax: PackageSize, pkg: PackageSize): boolean {
  return sizeRank[driverMax] >= sizeRank[pkg] && sizeRank[vehicleMaxSize[vehicle]] >= sizeRank[pkg];
}
