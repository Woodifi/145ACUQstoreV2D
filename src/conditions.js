// =============================================================================
// QStore IMS v2 — canonical condition list
// =============================================================================
// Lifted out of ui/inventory.js so non-UI modules (csv-import) can read it
// without dragging the inventory page's DOM dependencies into their bundle.
// inventory.js re-exports this so the existing import points still work.
//
// If you change this list, ensure CSS modifier classes in qstore.css cover
// every value (.inv__cond--<value>). The _deriveCondition helper in
// inventory.js maps these values to badge colours.
// =============================================================================

export const CONDITIONS = [
  { value: 'serviceable',      label: 'Serviceable'      },
  { value: 'unserviceable',    label: 'Unserviceable'    },
  { value: 'repair',           label: 'In repair'        },
  { value: 'calibration-due',  label: 'Calibration due'  },
  { value: 'written-off',      label: 'Written off'      },
];
