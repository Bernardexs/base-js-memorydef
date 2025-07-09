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

/*const encuestaFlow = addKeyword(EVENTS.ACTION) // NO usa keywords
  .addAction(async (ctx, { state, flowDynamic }) => {


    clearReminder(ctx.from, PRE_ENCUESTA)

    const { data } = await axios.get('http://localhost:7003/datos-encuesta')
    const { saludos, contactos, preguntas } = data
    const usuario = contactos.find(u => u.num === ctx.from)

    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.')
      return
    }

    // 2) Verificar estado en BD, manejando 404
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
    // si es 404 asumimos que no hay registro aún
  }
    if (estadoEncuesta==='completado') {
      await flowDynamic('✅ Ya completaste la encuesta. ¡Gracias!')
      return
    }

     // 3) Si no estaba “en progreso”, lo marcamos
  if (estadoEncuesta !== 'en progreso') {
    await axios.post('http://localhost:7003/marcar-como-completada', {
      idContacto: ctx.from,
      idEncuesta: preguntas[0].idEncuesta,
      idEmpresa: preguntas[0].idEmpresa
    });
  }

    const yaInicializado = await state.get('preguntas')
    if (yaInicializado) return

    await state.update({
      preguntas,
      respuestas: [],
      paso: 0,
      nombre: usuario.nombre,
      despedida: saludos[0]?.saludo3 || '✅ Gracias por participar en la encuesta.'
    })

    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos con tu encuesta.`)

    const p0 = preguntas[0]
    let msg0 = `1⃣ ${p0.pregunta}`

    if (p0.textoIni && p0.tipoRespuesta === 'RANGO') {
      msg0 += `\n*Califica del rango ${p0.rangoIni} al ${p0.rangoFin}*`
      msg0 += '\n' + p0.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n')
    } else if (p0.textoIni) {
      msg0 += '\n' + p0.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n')
    }

    await flowDynamic(msg0)
    scheduleReminder(ctx.from, 0, state)
  })
  .addAnswer(null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
    clearReminder(ctx.from)

    const datos = await state.getMyState()
    if (!datos || !datos.preguntas) return

    let { preguntas, respuestas, paso, despedida } = datos
    const preguntaActual = preguntas[paso]
    const respuesta = ctx.body.trim()

    console.log(`Respuesta del contacto ${ctx.from}: ${respuesta}`)

    if (preguntaActual.tipoRespuesta === 'RANGO') {
      const valor = parseInt(respuesta, 10)
      if (isNaN(valor) || valor < preguntaActual.rangoIni || valor > preguntaActual.rangoFin) {
        await flowDynamic(`❌ Por favor responde con un número entre ${preguntaActual.rangoIni} y ${preguntaActual.rangoFin}.`)
        return gotoFlow(encuestaFlow)
      }
    } else if (preguntaActual.tipoRespuesta === 'CONFIRMA') {
      const aceptadas = ['SI', 'NO', 'SÍ']
      if (!aceptadas.includes(respuesta.toUpperCase())) {
        await flowDynamic('❌ Responde solo con "SI" o "NO".')
        return gotoFlow(encuestaFlow)
      }
    }

    respuestas.push(respuesta)
    paso++

    if (paso >= preguntas.length) {
      await state.update({ finalizada: true, preguntas: null, respuestas: [], paso: null })

      const resumen = respuestas.map((r, i) => `❓ ${preguntas[i].pregunta}\n📝 ${r}`).join('\n\n')

      const payload = respuestas.map((r, i) => ({
        idContacto: ctx.from,
        idEncuesta: preguntas[i].idEncuesta,
        idEmpresa: preguntas[i].idEmpresa,
        pregunta: preguntas[i].pregunta,
        respuesta: r,
        tipo: preguntas[i].tipoRespuesta,
        idPregunta: preguntas[i].idPregunta
      }))

      try {
        await axios.post('http://localhost:7003/guardar-respuestas', payload)
        await flowDynamic('📩 Tus respuestas fueron enviadas exitosamente.')
        // Ahora, marcar la encuesta como completada
  await axios.post('http://localhost:7003/marcar-como-completada', {
    idContacto: ctx.from,  // Pasamos el idContacto
    idEncuesta: preguntas[0].idEncuesta,  // Usamos el idEncuesta de la primera pregunta
    idEmpresa: preguntas[0].idEmpresa,  // Usamos el idEmpresa de la primera pregunta
  });

  // Confirmamos que la encuesta fue completada
  await flowDynamic('✅ Encuesta completada y registrada exitosamente.');
      } catch (e) {
        console.error('Error al guardar respuestas:', e.message)
        await flowDynamic('⚠ Hubo un problema al guardar tus respuestas.')
      }

      await flowDynamic(despedida)
      return await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`)
    }

    const siguiente = preguntas[paso]
    let mensaje = `${paso + 1}⃣ ${siguiente.pregunta}`

    if (siguiente.textoIni && siguiente.tipoRespuesta === 'RANGO') {
      mensaje += `\n*Califica del rango ${siguiente.rangoIni} al ${siguiente.rangoFin}*`
      mensaje += '\n' + siguiente.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n')
    } else if (siguiente.textoIni) {
      mensaje += '\n' + siguiente.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n')
    }

    await state.update({ preguntas, respuestas, paso, despedida })
    await flowDynamic(mensaje)
    scheduleReminder(ctx.from, paso, state)
    return gotoFlow(encuestaFlow)
  })*/

    //Este es el mejor hasta ahora

const encuestaFlow = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { state, flowDynamic }) => {
    // Limpiar recordatorio previo
    clearReminder(ctx.from, PRE_ENCUESTA);

    // Traer datos de encuesta desde el backend
    const { data } = await axios.get('http://localhost:7003/datos-encuesta');
    const { saludos, contactos, preguntas } = data;
    const usuario = contactos.find(u => u.num === ctx.from);
    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.');
      return;
    }

    console.log(`Usuario encontrado: ${usuario.nombre}`);

    // Verificar el estado de la encuesta para este contacto
    const encuestaId = preguntas[0].idEncuesta;
    console.log(`id de encuesta ${encuestaId} para el contacto ${ctx.from}`);
    const prevEncuesta = await state.get('idEncuesta');
    const finalizadaPrev = await state.get('finalizada');
    console.log(`Encuesta previa: ${prevEncuesta}, Finalizada previa: ${finalizadaPrev}`);

    // Inicializar la variable estadoEncuesta
    let estadoEncuesta = 'no iniciado';

    // Verificar si la encuesta está en la base de datos
    try {
      const resp = await axios.post('http://localhost:7003/verificar-estado', {
        idContacto: ctx.from,
        idEncuesta: encuestaId
      });
      estadoEncuesta = resp.data.estadoEncuesta;
      console.log(`Estado de la encuesta: ${estadoEncuesta}`);
    } catch (err) {
      if (!(err.response && err.response.status === 404)) {
        console.error('Error inesperado al verificar estado:', err);
        throw err;
      }
      console.log('Encuesta no iniciada, creando registro nuevo');
    }

    // Si ya completó, informo y termino
    if (estadoEncuesta === 'completado') {
      await flowDynamic('✅ Ya completaste esta encuesta. ¡Gracias de nuevo!');
      return;
    }

    // Si el ID de la encuesta actual es diferente al anterior o ya se completó, reiniciar
    if ((prevEncuesta && prevEncuesta !== encuestaId) || finalizadaPrev) {
      console.log('Reiniciando la encuesta para este contacto');
      await state.update({ finalizada: false, preguntas: null, respuestas: [], paso: null });
    }

    // Guardar en memoria idEncuesta + idEmpresa
    await state.update({ idEncuesta: encuestaId, idEmpresa: preguntas[0].idEmpresa });
    console.log(`Guardado en memoria - idEncuesta: ${encuestaId}, idEmpresa: ${preguntas[0].idEmpresa}`);

    // Si ya tenemos preguntas, no reiniciamos
    if (await state.get('preguntas')) return;

    // Inicializar y lanzar primera pregunta
    await state.update({
      preguntas, respuestas: [], paso: 0,
      nombre: usuario.nombre,
      despedida: saludos[0]?.saludo3 || '✅ Gracias por participar en la encuesta.'
    });

    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos con tu encuesta.`);
    const p0 = preguntas[0];
    let msg = `1⃣ ${p0.pregunta}`;
    if (p0.textoIni && p0.tipoRespuesta === 'RANGO') {
      msg += `\n*Califica del rango ${p0.rangoIni} al ${p0.rangoFin}*`;
      msg += '\n' + p0.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n');
    } else if (p0.textoIni) {
      msg += '\n' + p0.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n');
    }
    await flowDynamic(msg);
    scheduleReminder(ctx.from, 0, state);
  })
  .addAnswer(null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
    clearReminder(ctx.from);

    // Obtener todo el estado
    const datos = await state.getMyState();
    if (!datos?.preguntas) return;

    // Destructurar incluyendo idEncuesta e idEmpresa
    let { preguntas, respuestas, paso, despedida, idEncuesta, idEmpresa } = datos;
    const preguntaActual = preguntas[paso];
    const respuesta      = ctx.body.trim();

    // Validaciones según tipo
    if (preguntaActual.tipoRespuesta === 'RANGO') {
      const v = parseInt(respuesta, 10);
      if (isNaN(v) || v < preguntaActual.rangoIni || v > preguntaActual.rangoFin) {
        await flowDynamic(`❌ Por favor responde un número entre ${preguntaActual.rangoIni} y ${preguntaActual.rangoFin}.`);
        return gotoFlow(encuestaFlow);
      }
    } else if (preguntaActual.tipoRespuesta === 'CONFIRMA') {
      if (!['SI','NO','SÍ'].includes(respuesta.toUpperCase())) {
        await flowDynamic('❌ Responde solo con "SI" o "NO".');
        return gotoFlow(encuestaFlow);
      }
    }

    // Guardar y avanzar
    respuestas.push(respuesta);
    paso++;

    // Si quedan preguntas, enviar siguiente
    if (paso < preguntas.length) {
      const s = preguntas[paso];
      let msg = `${paso+1}⃣ ${s.pregunta}`;
      if (s.textoIni && s.tipoRespuesta === 'RANGO') {
        msg += `\n*Califica del rango ${s.rangoIni} al ${s.rangoFin}*`;
        msg += '\n' + s.textoIni.split('=').map(x => x.replace('-', ' - ').trim()).join('\n');
      } else if (s.textoIni) {
        msg += '\n' + s.textoIni.split('=').map(x => x.replace('-', ' - ').trim()).join('\n');
      }
      await state.update({ preguntas, respuestas, paso, despedida });
      await flowDynamic(msg);
      scheduleReminder(ctx.from, paso, state);
      return gotoFlow(encuestaFlow);
    }

    // Última respuesta: cerrar encuesta
    await state.update({ finalizada: true, preguntas: null, respuestas: [], paso: null });

    // Preparar el payload
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
      console.log('Guardando respuestas...');
      // Guardar respuestas
      await axios.post('http://localhost:7003/guardar-respuestas', payload);
      await flowDynamic('📩 Tus respuestas fueron enviadas exitosamente.');

      // Marcar como completada en la base de datos
      await axios.post('http://localhost:7003/marcar-como-completada', {
        idContacto: ctx.from,
        idEncuesta: idEncuesta,
        idEmpresa: idEmpresa
      });

      // Actualizar estado del contacto
      estadoEncuestas[ctx.from][idEncuesta] = {
        estado: 'completado',
        idEmpresa,
        respuestas
      };

      await flowDynamic('✅ Encuesta completada y registrada exitosamente.');
    } catch (e) {
      console.error('Error al guardar respuestas:', e.message);
      await flowDynamic('⚠ Hubo un problema al guardar tus respuestas.');
    }

    // Resumen de respuestas
    const resumen = preguntas
      .map((p, i) => `❓ ${p.pregunta}\n📝 ${respuestas[i]}`)
      .join('\n\n');
    await flowDynamic(despedida);
    await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`);
  });


 














   

const negacionFlow = addKeyword(negaciones).addAction(async (ctx, { flowDynamic, state }) => {
  await state.update({ finalizada: true }) // ✅ Marca como finalizada si dice NO
  await flowDynamic('✅ Gracias por tu tiempo. Si deseas participar en otro momento, estaré disponible.')
})

const defaultFlow = addKeyword(afirmaciones)
  .addAction(async (ctx, { state, flowDynamic, gotoFlow }) => {
    // 1) Si ya completó la encuesta en esta sesión…
    const yaFinalizada = await state.get('finalizada');
    if (yaFinalizada) {
      await flowDynamic('✅ Ya completaste esta encuesta. ¡Gracias de nuevo!');
      return;
    }

    // 2) Si no, lo enviamos a arrancar el flujo de la encuesta
    return gotoFlow(encuestaFlow);
  })
  // (Opcional) captura de respuesta libre para “NO” u otras
  .addAnswer(null, { capture: true }, async (ctx, { gotoFlow, flowDynamic, state }) => {
    const texto = ctx.body.trim().toUpperCase();
    // Si terminó, no hacemos nada
    if (await state.get('finalizada')) return;
    if (negaciones.includes(texto)) {
      return gotoFlow(negacionFlow);
    }
    // Si no es un “SI” ni un “NO”, le pedimos que conteste así
    await flowDynamic('Por favor responde sólo Sí o No.');
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
