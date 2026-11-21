'use strict';

// Official Bungoma County constituency and ward reference data.
// Ward IDs are stable and unique within the county.
// This file is the backend source of truth; the UI will later
// retrieve location options through the Express API.

const COUNTY = Object.freeze({
  id: 'bungoma',
  name: 'Bungoma'
});

const rawConstituencies = [
  {
    id: 'kanduyi',
    name: 'Kanduyi',
    wards: [
      'Bukembe West',
      'Bukembe East',
      'Township',
      'Khalaba',
      'Musikoma',
      'East Sang’alo',
      'West Sang’alo',
      'Tuuti/Marakaru'
    ]
  },
  {
    id: 'bumula',
    name: 'Bumula',
    wards: [
      'South Bukusu',
      'Bumula',
      'Khasoko',
      'Kabula',
      'Kimaeti',
      'West Bukusu',
      'Siboti'
    ]
  },
  {
    id: 'webuye-east',
    name: 'Webuye East',
    wards: [
      'Mihuu',
      'Ndivisi',
      'Maraka'
    ]
  },
  {
    id: 'webuye-west',
    name: 'Webuye West',
    wards: [
      'Sitikho',
      'Matulo',
      'Bokoli',
      'Misikhu'
    ]
  },
  {
    id: 'kabuchai',
    name: 'Kabuchai',
    wards: [
      'Kabuchai/Chwele',
      'West Nalondo',
      'Bwake/Luuya',
      'Mukuyuni'
    ]
  },
  {
    id: 'sirisia',
    name: 'Sirisia',
    wards: [
      'Namwela',
      'Malakisi/South Kulisiru',
      'Lwandanyi'
    ]
  },
  {
    id: 'tongaren',
    name: 'Tongaren',
    wards: [
      'Mbakalo',
      'Naitiri/Kabuyefwe',
      'Milima',
      'Ndalu',
      'Tongaren',
      'Soysambu/Mitua'
    ]
  },
  {
    id: 'kimilili',
    name: 'Kimilili',
    wards: [
      'Kibingei',
      'Kimilili',
      'Maeni',
      'Kamukuywa'
    ]
  },
  {
    id: 'mt-elgon',
    name: 'Mt Elgon',
    wards: [
      'Cheptais',
      'Chesikaki',
      'Chepyuk',
      'Kapkateny',
      'Kaptama',
      'Elgon'
    ]
  }
];

function slugify(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const CONSTITUENCIES = Object.freeze(
  rawConstituencies.map((constituency) =>
    Object.freeze({
      id: constituency.id,
      name: constituency.name,
      wards: Object.freeze(
        constituency.wards.map((name) =>
          Object.freeze({
            id: `${constituency.id}-${slugify(name)}`,
            name
          })
        )
      )
    })
  )
);

function normalizeName(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : '';
}

function getConstituencyById(constituencyId) {
  return CONSTITUENCIES.find(
    (item) => item.id === constituencyId
  ) || null;
}

function getConstituencyByName(name) {
  const normalized = normalizeName(name);

  return CONSTITUENCIES.find(
    (item) => normalizeName(item.name) === normalized
  ) || null;
}

function getWardsByConstituency(constituencyId) {
  const constituency = getConstituencyById(constituencyId);
  return constituency ? constituency.wards : [];
}

function getWardById(constituencyId, wardId) {
  const wards = getWardsByConstituency(constituencyId);

  return wards.find((ward) => ward.id === wardId) || null;
}

function isValidConstituencyWard(constituencyId, wardId) {
  return getWardById(constituencyId, wardId) !== null;
}

module.exports = Object.freeze({
  COUNTY,
  CONSTITUENCIES,
  getConstituencyById,
  getConstituencyByName,
  getWardsByConstituency,
  getWardById,
  isValidConstituencyWard
});
