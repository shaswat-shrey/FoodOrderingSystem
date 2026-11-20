import { Card, DietaryMarker } from '@fos/ui';
import { APP_INFO } from '../app-info';
import { PlatformStatus } from '../components/PlatformStatus';

export function HomePage() {
  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{APP_INFO.title}</h1>
        <p className="mt-1 text-gray-600">{APP_INFO.tagline}</p>
      </section>

      <Card>
        <h2 className="text-sm font-semibold text-gray-500">What this app will do</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-gray-800">
          {APP_INFO.features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
        <p className="mt-4 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
          Awaiting implementation: these screens are built in {APP_INFO.buildPhase}. This page
          currently shows the app shell and live platform status only.
        </p>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-gray-500">Food markers used across the app</h2>
        <ul className="mt-3 flex flex-wrap gap-4 text-sm">
          <li className="flex items-center gap-2">
            <DietaryMarker type="VEG" /> Vegetarian
          </li>
          <li className="flex items-center gap-2">
            <DietaryMarker type="NON_VEG" /> Non-vegetarian
          </li>
          <li className="flex items-center gap-2">
            <DietaryMarker type="EGG" /> Contains egg
          </li>
        </ul>
      </Card>
      <PlatformStatus />
    </div>
  );
}
