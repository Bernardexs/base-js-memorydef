import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from 'dotenv'
import axios from 'axios'
dotenv.config()

const PORT = process.env.PORT ?? 3008

export const provider = createProvider(Provider, {
  jwtToken: process.env.jwtToken,
  numberId: process.env.numberId,
  verifyToken: process.env.verifyToken,
  version: process.env.version
})

const afirmaciones = ['SI', 'SÍ', 'CLARO', 'DALE', 'LISTO', 'ACEPTO', 'VOY', 'DE UNA', 'OK']
const negaciones = ['NO', 'NO GRACIAS', 'NUNCA', 'NEGADO', 'AHORA NO', 'NO DESEARÍA', 'PASO']

const INACTIVITY_MINUTES = 1
const inactivityTimers = new Map()
const reminderCounts = new Map()
const PRE_ENCUESTA = -1 // paso especial para recordatorio inicial

function clearReminder(user, paso = null) {
  if (inactivityTimers.has(user)) {
    clearTimeout(inactivityTimers.get(user))
    inactivityTimers.delete(user)
  }
  if (paso !== null) {
    reminderCounts.delete(`${user}-${paso}`)
  }
}

function scheduleReminder(user, paso, state) {
  clearReminder(user)

  const key = `${user}-${paso}`
  const currentCount = reminderCounts.get(key) || 0
  if (currentCount >= 2) return // máximo 2 recordatorios

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState()
    if (!datos || datos.paso !== paso) return

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(
          user,
          '👋 Hola, ¿aún te interesa participar en la encuesta? Responde *sí* o *no* para continuar.'
        )
      } else {
        await provider.sendText(
          user,
          `🙏 ¿Podrías ayudarnos respondiendo la pregunta ${paso + 1}?`
        )
      }
    } catch (e) {
      console.error('❌ Error al enviar recordatorio:', e.message)
    }

    reminderCounts.set(key, currentCount + 1)
    scheduleReminder(user, paso, state)
  }, INACTIVITY_MINUTES * 60 * 1000)

  inactivityTimers.set(user, timeoutId)
}

const encuestaFlow = addKeyword(EVENTS.ACTION) // NO usa keywords
  // ——————————————————————————————————————————————————————————————
  // 1) ACCIÓN INICIAL: chequeo de `finalizada` en memoria, verificación en BD y arranque
  .addAction(async (ctx, { state, flowDynamic }) => {
    // Si ya completó la encuesta en esta sesión, detenemos aquí:
    const yaLocal = await state.get('finalizada');
    if (yaLocal) {
      await flowDynamic('✅ Ya completaste esta encuesta. ¡Gracias de nuevo!');
      return;
    }

    // Limpiar timers de recordatorio
    clearReminder(ctx.from, PRE_ENCUESTA);

    // 1. Cargar datos de encuesta
    const { data } = await axios.get('http://localhost:7003/datos-encuesta');
    const { saludos, contactos, preguntas } = data;
    const usuario = contactos.find(u => u.num === ctx.from);
    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.');
      return;
    }

    // 2. Verificar estado en BD (404 ⇒ "no iniciado")
    let estadoEncuesta = 'no iniciado';
    try {
      const resp = await axios.post('http://localhost:7003/verificar-estado', {
        idContacto: ctx.from,
        idEncuesta: usuario.idEncuesta
      });
      estadoEncuesta = resp.data.estadoEncuesta;
    } catch (err) {
      if (!(err.response && err.response.status === 404)) {
        console.error('Error inesperado al verificar estado:', err);
        throw err;
      }
      // si es 404, asumimos que no hay registro aún
    }

    // 3. Si ya está completada, avisamos y salimos
    if (estadoEncuesta === 'completado') {
      await flowDynamic('✅ Ya completaste la encuesta. ¡Gracias!');
      return;
    }

    // 4. Si no estaba "en progreso", la marcamos ahora
    if (estadoEncuesta !== 'en progreso') {
      await axios.post('http://localhost:7003/marcar-como-completada', {
        idContacto: ctx.from,
        idEncuesta: preguntas[0].idEncuesta,
        idEmpresa: preguntas[0].idEmpresa
      });
    }

    // 5. Si ya cargamos las preguntas en memoria, no las recargamos
    const yaInit = await state.get('preguntas');
    if (yaInit) return;

    // 6. Inicializar estado local y lanzar primera pregunta
    await state.update({
      preguntas,
      respuestas: [],
      paso: 0,
      nombre: usuario.nombre,
      despedida: saludos[0]?.saludo3 || '✅ Gracias por participar en la encuesta.'
    });

    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos con tu encuesta.`);
    const p0 = preguntas[0];
    let msg0 = `1⃣ ${p0.pregunta}`;
    if (p0.textoIni) {
      msg0 += '\n' + p0.textoIni
        .split('=')
        .map(s => s.trim())
        .join('\n');
    }
    await flowDynamic(msg0);

    // Programar primer recordatorio
    scheduleReminder(ctx.from, 0, state);
  })

  // ——————————————————————————————————————————————————————————————
  // 2) RESPUESTAS: avanzamos paso a paso y, al final, guardamos y cerramos
  .addAnswer(null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
    // Limpiar recordatorio actual
    clearReminder(ctx.from);

    const datos = await state.getMyState();
    if (!datos || !datos.preguntas) return;

    let { preguntas, respuestas, paso, despedida } = datos;
    const preguntaActual = preguntas[paso];
    const respuesta = ctx.body.trim();

    console.log(`Respuesta del contacto ${ctx.from}: ${respuesta}`);

    // Validaciones de RANGO o CONFIRMA
    if (preguntaActual.tipoRespuesta === 'RANGO') {
      const valor = parseInt(respuesta, 10);
      if (isNaN(valor) || valor < preguntaActual.rangoIni || valor > preguntaActual.rangoFin) {
        await flowDynamic(`❌ Por favor responde con un número entre ${preguntaActual.rangoIni} y ${preguntaActual.rangoFin}.`);
        return gotoFlow(encuestaFlow);
      }
    } else if (preguntaActual.tipoRespuesta === 'CONFIRMA') {
      const aceptadas = ['SI', 'NO', 'SÍ'];
      if (!aceptadas.includes(respuesta.toUpperCase())) {
        await flowDynamic('❌ Responde solo con "SI" o "NO".');
        return gotoFlow(encuestaFlow);
      }
    }

    // Guardar respuesta y avanzar
    respuestas.push(respuesta);
    paso++;

    // Si quedan preguntas, continuar flujo
    if (paso < preguntas.length) {
      const siguiente = preguntas[paso];
      let msg = `${paso + 1}⃣ ${siguiente.pregunta}`;
      if (siguiente.textoIni) {
        msg += '\n' + siguiente.textoIni
          .split('=')
          .map(s => s.trim())
          .join('\n');
      }
      await state.update({ preguntas, respuestas, paso, despedida });
      await flowDynamic(msg);
      scheduleReminder(ctx.from, paso, state);
      return gotoFlow(encuestaFlow);
    }

    // Última respuesta: cerrar encuesta
    await state.update({ finalizada: true, preguntas: null, respuestas: [], paso: null });

    // 1) Enviar respuestas al backend
    const payload = preguntas.map((p, i) => ({
      idContacto: ctx.from,
      idEncuesta: p.idEncuesta,
      idEmpresa: p.idEmpresa,
      pregunta: p.pregunta,
      respuesta: respuestas[i],
      tipo: p.tipoRespuesta,
      idPregunta: p.idPregunta
    }));

    try {
      await axios.post('http://localhost:7003/guardar-respuestas', payload);
      await flowDynamic('📩 Tus respuestas fueron enviadas exitosamente.');

      // 2) Marcar completado en BD
      await axios.post('http://localhost:7003/marcar-como-completada', {
        idContacto: ctx.from,
        idEncuesta: preguntas[0].idEncuesta,
        idEmpresa: preguntas[0].idEmpresa
      });
      await flowDynamic('✅ Encuesta completada y registrada exitosamente.');
    } catch (e) {
      console.error('Error al guardar respuestas:', e.message);
      await flowDynamic('⚠ Hubo un problema al guardar tus respuestas.');
    }

    // 3) Despedida y resumen (¡sin volver a gotoFlow!)
    const resumen = respuestas
      .map((r, i) => `❓ ${preguntas[i].pregunta}\n📝 ${r}`)
      .join('\n\n');

    await flowDynamic(despedida);
    return await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`);
  });


const negacionFlow = addKeyword(negaciones).addAction(async (ctx, { flowDynamic, state }) => {
  await state.update({ finalizada: true }) // ✅ Marca como finalizada si dice NO
  await flowDynamic('✅ Gracias por tu tiempo. Si deseas participar en otro momento, estaré disponible.')
})

const defaultFlow = addKeyword(afirmaciones)
  // Si ya finalizó, avisamos y no hacemos nada más
  .addAction(async (ctx, { state, flowDynamic }) => {
    const yaFinalizada = await state.get('finalizada');
    if (yaFinalizada) {
      await flowDynamic('✅ Ya completaste esta encuesta. ¡Gracias de nuevo!');
      return;
    }
    // Si no está finalizada, iniciamos el flujo de la encuesta
    return gotoFlow(encuestaFlow);
  })

  // Capturamos cualquier texto (para manejar afirmaciones o negaciones)
  .addAnswer(null, { capture: true }, async (ctx, { state, gotoFlow, flowDynamic }) => {
    const texto = ctx.body.trim().toUpperCase();
    const yaFinalizada = await state.get('finalizada');

    if (yaFinalizada) {
      // Si ya terminó, ignoramos todo lo que escriba
      return;
    }

    if (afirmaciones.includes(texto)) {
      return gotoFlow(encuestaFlow);
    } else if (negaciones.includes(texto)) {
      return gotoFlow(negacionFlow);
    }

    // (Opcional) Si escribe otra cosa distinta, podrías reenviarle un mensaje de ayuda:
    await flowDynamic('Por favor responde Sí o No.');
  });


const main = async () => {
  const adapterFlow = createFlow([encuestaFlow, negacionFlow, defaultFlow])
  const adapterDB = new Database()

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider,
    database: adapterDB
  })

  provider.server.get('/v1/prueba', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('✅ Ruta activa: /v1/prueba (GET)')
  })

  httpServer(+PORT)
}

main()
