/* Subida de archivos grandes por trozos, reanudable.
 *
 * El equipo sube escenas de mas de un gigabyte desde distintas ciudades y por
 * conexiones que se cortan. En vez de un envio unico que hay que repetir
 * entero al primer tropiezo, el archivo se parte y cada trozo se reintenta por
 * separado. Si se cierra la pestana, la subida se puede retomar despues:
 * el servidor recuerda que trozos ya recibio.
 */

import { api, avisar, escapar, numero, $ } from './util.js';

const TROZO = 8 * 1024 * 1024;      // 8 MB: peticiones cortas incluso en 4G flojo
const REINTENTOS = 5;
const MEMORIA = 'geovisor.subidas';

/** Subidas en curso en esta pestana, por id. */
const enCurso = new Map();
let alTerminar = () => {};

export function alTerminarSubida(fn) { alTerminar = fn; }

const mb = (bytes) => `${numero(bytes / 1024 / 1024, 1)} MB`;
const espera = (ms) => new Promise((listo) => setTimeout(listo, ms));

// --- Memoria entre sesiones ------------------------------------------------
// Guarda que archivo corresponde a que subida, para poder ofrecer retomarla.
const recordadas = () => {
  try { return JSON.parse(localStorage.getItem(MEMORIA) || '{}'); }
  catch { return {}; }
};
const recordar = (clave, id) => {
  const todas = recordadas();
  if (id) todas[clave] = id; else delete todas[clave];
  localStorage.setItem(MEMORIA, JSON.stringify(todas));
};
const claveDe = (archivo) => `${archivo.name}|${archivo.size}`;

// ---------------------------------------------------------------------------
// Subida de un archivo
// ---------------------------------------------------------------------------
class Subida {
  constructor(archivo, nombre, tipo) {
    this.archivo = archivo;
    this.nombre = nombre;
    this.tipo = tipo;
    this.id = null;
    this.recibidos = new Set();
    this.total = 0;
    this.tamTrozo = TROZO;
    this.cancelada = false;
    this.pausada = false;
    this.fila = null;
  }

  get progreso() {
    if (!this.total) return 0;
    return Math.round((this.recibidos.size / this.total) * 100);
  }

  async iniciar() {
    const clave = claveDe(this.archivo);
    const previa = recordadas()[clave];

    if (previa) {
      // Retomar: preguntar al servidor por donde iba.
      try {
        const estado = await api(`/api/subidas/${previa}`);
        if (estado.tamano === this.archivo.size) {
          this.adoptar(estado);
          this.mostrar(`Retomando desde ${this.progreso}%`);
          return;
        }
      } catch { /* caducada o borrada: se crea una nueva */ }
      recordar(clave, null);
    }

    const estado = await api('/api/subidas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivo: this.archivo.name,
        nombre: this.nombre,
        tamano: this.archivo.size,
        tam_trozo: TROZO,
        tipo: this.tipo,
      }),
    });
    this.adoptar(estado);
    recordar(clave, this.id);
  }

  adoptar(estado) {
    this.id = estado.id;
    this.total = estado.total_trozos;
    this.tamTrozo = estado.tam_trozo;
    this.recibidos = new Set(estado.trozos_recibidos);
  }

  async enviarTodo() {
    for (let indice = 0; indice < this.total; indice++) {
      if (this.cancelada) return;
      while (this.pausada && !this.cancelada) await espera(400);
      if (this.recibidos.has(indice)) continue;

      await this.enviarTrozo(indice);
      this.recibidos.add(indice);
      this.mostrar();
    }
  }

  async enviarTrozo(indice) {
    const desde = indice * this.tamTrozo;
    const pedazo = this.archivo.slice(desde, Math.min(desde + this.tamTrozo, this.archivo.size));

    for (let intento = 1; intento <= REINTENTOS; intento++) {
      if (this.cancelada) throw new Error('Cancelada');
      try {
        const respuesta = await fetch(`/api/subidas/${this.id}/${indice}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: pedazo,
        });
        if (respuesta.status === 401) { location.href = '/login.html'; throw new Error('Sesion expirada'); }
        if (respuesta.ok) return;

        // 4xx que no sea 408/429 es un problema del archivo, no de la red:
        // reintentar no va a arreglarlo.
        if (respuesta.status >= 400 && respuesta.status < 500 &&
            ![408, 429].includes(respuesta.status)) {
          const cuerpo = await respuesta.json().catch(() => ({}));
          throw new Error(cuerpo.detail || `Error ${respuesta.status}`);
        }
      } catch (error) {
        if (error.message === 'Cancelada' || intento === REINTENTOS) throw error;
      }
      // Espera creciente: 1s, 2s, 4s, 8s. Da tiempo a que vuelva la senal.
      const pausa = 1000 * 2 ** (intento - 1);
      this.mostrar(`Sin conexión, reintentando en ${pausa / 1000}s…`);
      await espera(pausa);
    }
    throw new Error(`No se pudo enviar el trozo ${indice + 1} de ${this.total}`);
  }

  async finalizar() {
    const resultado = await api(`/api/subidas/${this.id}/finalizar`, { method: 'POST' });
    recordar(claveDe(this.archivo), null);
    return resultado;
  }

  async cancelar() {
    this.cancelada = true;
    recordar(claveDe(this.archivo), null);
    if (this.id) await api(`/api/subidas/${this.id}`, { method: 'DELETE' }).catch(() => {});
    enCurso.delete(this.id);
    this.fila?.remove();
    pintarPanel();
  }

  mostrar(mensaje) {
    if (!this.fila) return;
    const barra = this.fila.querySelector('progress');
    const texto = this.fila.querySelector('.avance');
    barra.value = this.progreso;
    const subidos = Math.min(this.recibidos.size * this.tamTrozo, this.archivo.size);
    texto.textContent = mensaje || `${this.progreso}% · ${mb(subidos)} de ${mb(this.archivo.size)}`;
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function pintarPanel() {
  const panel = $('panel-subidas');
  panel.hidden = enCurso.size === 0;
}

function crearFila(subida) {
  const fila = document.createElement('div');
  fila.className = 'subida-fila';
  fila.innerHTML = `
    <div class="subida-cabecera">
      <span class="nombre" title="${escapar(subida.archivo.name)}">${escapar(subida.nombre)}</span>
      <button class="icono" data-accion="pausa" title="Pausar">&#10073;&#10073;</button>
      <button class="icono" data-accion="cancelar" title="Cancelar">&times;</button>
    </div>
    <progress max="100" value="0"></progress>
    <span class="avance">Preparando…</span>`;

  fila.querySelector('[data-accion=pausa]').onclick = (evento) => {
    subida.pausada = !subida.pausada;
    evento.target.innerHTML = subida.pausada ? '&#9654;' : '&#10073;&#10073;';
    evento.target.title = subida.pausada ? 'Reanudar' : 'Pausar';
    if (subida.pausada) subida.mostrar('En pausa');
  };
  fila.querySelector('[data-accion=cancelar]').onclick = () => {
    if (confirm(`¿Cancelar la subida de "${subida.nombre}"?`)) subida.cancelar();
  };

  $('lista-subidas').appendChild(fila);
  subida.fila = fila;
  pintarPanel();
  return fila;
}

/**
 * Sube un archivo y lo publica. Devuelve lo que respondio el servidor.
 * @param {File} archivo
 * @param {string} nombre  nombre de la capa a crear
 * @param {'raster'|'vector'} tipo
 */
export async function subir(archivo, nombre, tipo) {
  const subida = new Subida(archivo, nombre, tipo);
  crearFila(subida);

  try {
    await subida.iniciar();
    enCurso.set(subida.id, subida);
    await subida.enviarTodo();
    if (subida.cancelada) return null;

    subida.mostrar('Publicando…');
    const resultado = await subida.finalizar();

    enCurso.delete(subida.id);
    subida.fila.remove();
    pintarPanel();
    alTerminar(resultado);
    return resultado;
  } catch (error) {
    subida.mostrar(`Falló: ${error.message}`);
    subida.fila.classList.add('fallida');
    // No se borra la subida en el servidor: los trozos que ya llegaron siguen
    // ahi, y volver a elegir el mismo archivo continua donde se quedo.
    avisar(`${subida.nombre}: ${error.message}. Vuelve a elegir el archivo para continuar.`, true);
    enCurso.delete(subida.id);
    throw error;
  }
}

export const haySubidasActivas = () => enCurso.size > 0;

// Aviso al cerrar con subidas a medias: se pueden retomar, pero conviene
// que quien esta subiendo lo sepa antes de cerrar.
window.addEventListener('beforeunload', (evento) => {
  if (!haySubidasActivas()) return;
  evento.preventDefault();
  evento.returnValue = '';
});
